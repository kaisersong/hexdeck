# HexDeck 发布设置指南

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
   git tag v0.2.0
   git push origin v0.2.0
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