# nib

使用 Python 和 DeepSeek API 从零实现的终端个人 agent，参考 HKUDS/nanobot 逐步学习开发。

## 当前功能

- 多轮对话与工具调用循环，每条用户消息最多请求模型 5 次。
- 列出 `notes` 当前层的 Markdown 文件，读取并根据正文回答。
- 读取前校验路径边界；工具错误作为结果返回模型。
- 启动时加载会话，输入 `exit` 时保存。
- 使用 `/prefs` 查看偏好、`/set 键 值` 设置偏好、`/del 键` 删除偏好。

## 运行（PowerShell，Python 3.10+）

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$secret = Read-Host "输入 DeepSeek API Key" -AsSecureString
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new("", $secret).Password
Remove-Variable secret
.\.venv\Scripts\python.exe main.py
```

把 UTF-8 编码的 `.md` 笔记放在 `notes` 目录中，然后输入“请列出我的笔记”或“请读取 test.md 并总结”。读取的正文会发送给模型服务。

会话保存在 `session.json`，偏好保存在 `preferences.json`。这些个人数据、笔记、环境配置和本地学习记录均不提交到仓库。

当前是学习原型：仅正常输入 `exit` 时保存会话，尚未处理网络故障、损坏的数据文件或历史长度限制。
