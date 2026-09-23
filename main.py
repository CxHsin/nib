import os
from openai import OpenAI
from pathlib import Path
import json

notes_dir = Path(__file__).resolve().parent / "notes"


def list_notes() -> list[str]:
     md_files = [
        f for f in os.listdir(notes_dir)
        if os.path.isfile(os.path.join(notes_dir, f)) and f.endswith('.md')
    ]
     return sorted(md_files)

def read_note(filename: str) -> str:
    root = notes_dir.resolve()
    target = (root / filename).resolve()

    if target.parent != root:  # target.parent 必须等于 root
        raise ValueError("只允许读取笔记目录当前层的文件")

    if target.suffix != ".md":  # 只允许 .md
        raise ValueError("只允许读取 Markdown 文件")

    if not target.is_file():  # 必须是存在的文件
        raise FileNotFoundError("笔记不存在或不是文件")

    return target.read_text(encoding="utf-8")  # 用 UTF-8 读取正文


client = OpenAI(
    api_key=os.environ["DEEPSEEK_API_KEY"],
    base_url="https://api.deepseek.com",
)

tools = [
    {
        "type": "function",
        "function": {
            "name": "list_notes",
            "description": "列出学习笔记目录当前层的 Markdown 文件名。",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                },
            },
        },
    {
    "type": "function",
    "function": {
        "name": "read_note",
        "description": "读取学习笔记目录当前层的一份 Markdown 笔记。",
        "parameters": {
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "笔记文件名，包含 .md 后缀",
                }
            },
            "required": ["filename"],
            "additionalProperties": False,
            },
        },
    }
]


SESSION_FILE = Path(__file__).resolve().parent / "session.json"

def save_session(messages: list[dict]) -> None:
    text = json.dumps(
        messages,
        ensure_ascii=False,
        indent=2,
    )
    SESSION_FILE.write_text(text, encoding="utf-8")

def load_session() -> list[dict]:
    if not SESSION_FILE.exists():
        return []

    text = SESSION_FILE.read_text(encoding="utf-8")
    messages = json.loads(text)  # 将 JSON 字符串还原为 Python 对象

    if not isinstance(messages, list):
        raise ValueError("会话内容必须是列表")

    return messages

PREFERENCES_FILE = Path(__file__).resolve().parent / "preferences.json"

def load_preferences() -> dict[str, str]:
    if not PREFERENCES_FILE.exists():
        return {}
    return json.loads(PREFERENCES_FILE.read_text(encoding="utf-8"))

def save_preferences(preferences: dict[str, str]) -> None:
    PREFERENCES_FILE.write_text(
        json.dumps(preferences, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

def set_preference(key: str, value: str) -> None:
    preferences = load_preferences()
    preferences[key] = value
    save_preferences(preferences)

def get_preferences() -> dict[str, str]:
    return load_preferences()

def delete_preference(key: str) -> bool:
    preferences = load_preferences()
    if key not in preferences:
        return False
    del preferences[key]
    save_preferences(preferences)
    return True


MAX_MODEL_CALLS = 5
messages = load_session()


while True:
    s = input("请输入内容？")

    if s == "exit":
        print("好的，再见！有需要随时回来聊 nib。👋")
        save_session(messages)
        break

    if s == "/prefs":
        print(get_preferences())
        continue

    if s.startswith("/set "):
        parts = s.split(maxsplit=2)
        if len(parts) != 3:
            print("用法：/set 键 值")
            continue

        key, value = parts[1], parts[2]
        set_preference(key, value)
        print("偏好已保存")
        continue

    if s.startswith("/del "):
        key = s.split(maxsplit=1)[1].strip()
        deleted = delete_preference(key)  # 删除这项偏好，取得布尔返回值
        print("已删除" if deleted else "该偏好不存在")
        continue


    preferences = get_preferences()
    system_message = {
    "role": "system",
    "content": (
        "你是 nib，一个学习助手。"
        "以下是用户偏好，在适用时遵循：\n"
        + json.dumps(preferences, ensure_ascii=False)
        ),
    }

    messages.append(
        {"role": "user", "content": s},
    )

    for step in range(MAX_MODEL_CALLS):
        print(f"[模型请求] 第 {step + 1} 次")
        final_response = client.chat.completions.create(
            model="deepseek-chat",
            messages=[system_message] + messages,
            tools=tools,
            tool_choice="none" if step == MAX_MODEL_CALLS - 1 else "auto",
        )

        reply = final_response.choices[0].message
        messages.append(reply.model_dump(exclude_none=True))

        if not reply.tool_calls:
            print(reply.content)
            break

        for call in reply.tool_calls:
            print("[工具请求]", call.function.name, call.function.arguments)

            try:
                arguments = json.loads(call.function.arguments)

                if not isinstance(arguments, dict):
                    raise ValueError("工具参数必须是对象")

                if call.function.name == "list_notes":
                    if arguments != {}:
                        raise ValueError("list_notes 不接受参数")
                    result = list_notes()

                elif call.function.name == "read_note":
                    if set(arguments) != {"filename"}:
                        raise ValueError("read_note 必须且只能接收 filename")

                    filename = arguments["filename"]
                    if not isinstance(filename, str):
                        raise ValueError("filename 必须是字符串")

                    result = read_note(filename)

                else:
                    raise ValueError("未知工具")

            except (ValueError, OSError) as error:
                print("[工具失败]", type(error).__name__, str(error))
                result = {"error": str(error)}

            messages.append({
                "role": "tool",
                "tool_call_id": call.id,
                "content": json.dumps(result, ensure_ascii=False),
            })
