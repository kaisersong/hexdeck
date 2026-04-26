# HexDeck 发布设置指南

## 当前发布版本

- App version: `0.2.6`
- Tag: `v0.2.6`

## 0.2.6 发布要点

- 启用 Tauri bundle 与 updater 产物生成，修复 GitHub release workflow 缺少 `.app.tar.gz` / `.sig` 资产的问题
- 补上 `public/hexdeck-menu-tray.png`，修复 GitHub macOS release 构建因缺失 tray 资源而失败的问题
- Windows 下本地 broker `node --experimental-sqlite src/cli.js` 继续保持隐藏后台启动，不再弹出 node shell 窗口

## GitHub Secrets 配置

在 GitHub 仓库 Settings -> Secrets and variables -> Actions 中添加以下 secrets:

### 1. TAURI_SIGNING_PRIVATE_KEY

**先生成密钥对** (本地执行):
```bash
npx tauri signer generate -w ~/.tauri/hexdeck.key
# 密码留空，直接回车两次
```

**然后将私钥内容复制到 GitHub Secrets**:
```bash
cat ~/.tauri/hexdeck.key
# 复制输出内容 (包括 BEGIN/END PRIVATE KEY 行)
```

### 2. TAURI_SIGNING_PRIVATE_KEY_PASSWORD
留空（不设置密码）

### 3. 公钥配置

生成密钥后，将公钥填入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`:
```bash
cat ~/.tauri/hexdeck.key.pub
# 将公钥转换为 base64 格式填入配置
```

## 推送 Workflow 文件

由于 GitHub OAuth 权限限制，需要手动推送 workflow 文件:

```bash
cd /Users/song/projects/hexdeck
git add .github/workflows/release.yml
git commit -m "chore: add GitHub Actions release workflow"
git push
```

如果仍然被拒绝，需要在 GitHub 上授权 OAuth 应用的 workflow 权限，或者直接在 GitHub 上创建文件。

## 发布流程

1. 更新版本号
2. 创建 tag 并推送:
   ```bash
   git tag v0.2.6
   git push origin v0.2.6
   ```

3. GitHub Actions 会自动:
   - 构建 macOS aarch64 应用
   - 签名并上传到 Releases
   - 生成 latest.json 用于自动更新

## Intent-Broker 发布

Intent-broker 的 release workflow 已创建在:
`/Users/song/projects/intent-broker/.github/workflows/release.yml`

发布流程相同：创建 tag 并推送即可。

## 本地测试构建

```bash
cd /Users/song/projects/hexdeck
npm run tauri build -- --target aarch64-apple-darwin
```

## 密钥备份

私钥已保存在：`~/.tauri/hexdeck.key`
公钥已保存在：`~/.tauri/hexdeck.key.pub`

**重要**: 
- 如果丢失私钥，将无法发布更新！
- **不要将私钥提交到 Git 仓库！**
