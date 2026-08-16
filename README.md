# DeepSeek Harness Tray（DSH 桌面托盘插件）

给 DeepSeek Harness 加上桌面托盘体验：双击桌面图标即可启动 Harness，全程只驻留系统托盘，任务完成右下角弹窗通知，并智能管理电源。

## 功能

- **一键启动**：双击桌面 exe 即启动 Harness（自动执行 `npx @deepseek-ai/dsh web`），无需命令行；托盘图标带运行状态点
- **任务完成通知**：通过配套的 DSH 插件（`plugin/dsh-tray-notifier.mjs`）监听 `agent/status`，任务完成时在屏幕右下角弹出自定义样式通知
- **电源管理**：
  - 任务进行中阻止计算机休眠（防长任务被打断）
  - 任务全部完成且用户已离开（可配置空闲时长）后自动睡眠省电，宽限期内检测到操作自动取消
- **唯一 Harness 窗口**：所有"打开 Harness"入口复用同一个应用内窗口，带浏览器化操作（F5/Ctrl+R 刷新、Ctrl+W 隐藏、右键编辑菜单、输入框引号/括号自动配对）；窗口内其他子网址自动转到默认浏览器打开
- **Harness 进程接管**：运行中的 Harness 进程会被接管为插件管辖（停止/重启/退出随动）
- **开机自启**（可配置）、启动时自动拉起 Harness、自动打开界面（可配置）
- **GitHub 账户**：登录并保存访问令牌后，DSH 可直接使用该账户创建仓库、提交与推送代码，插件市场搜索同步获得认证
- 设置界面为深色玻璃拟态风格，支持最小化到任务栏 / 关闭到托盘

## 安装

### 桌面应用（Windows）

```powershell
# 1. 构建（需要 Node.js 18+）
npm install
npm run icons
npx electron-builder --win portable
# 产物：out/DeepSeek-Harness-Tray-<version>.exe，复制到桌面双击运行
```

### DSH 通知插件（DeepSeek Harness 侧）

把 `plugin/dsh-tray-notifier.mjs` 放入 `$DSH_HOME/plugins/`，并在用户补丁层（`$DSH_HOME/cordis.patch.yml`）添加：

```yaml
- insert:
    - id: dsh-tray-notifier
      name: 'file:///C:/Users/<用户>/.dsh/plugins/dsh-tray-notifier.mjs'
```

DSH 的补丁热加载会立即生效，无需重启。

## 开发

```bash
npm start        # 运行（electron .）
npm test         # 无头回归测试（node test/run.js）
npm run icons    # 重新生成图标
```

- `main.js` — 主进程（托盘/窗口/电源/进程接管/GitHub）
- `dsh-preload.js` — Harness 窗口内的浏览器化输入辅助（引号自动配对等）
- `ui/` — 设置窗口与通知弹窗
- `test/` — mock Electron 无头测试

## 许可

MIT
