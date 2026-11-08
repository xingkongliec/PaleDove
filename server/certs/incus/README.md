# Incus 客户端证书目录

由开发者自行创建证书，将以下两个文件上传到此目录：

- `client.crt`：PEM 格式的 X.509 客户端证书。
- `client.key`：与证书匹配的未加密 PEM 私钥（PKCS#8 或 PKCS#1）。

面板只读取这两个文件，不会生成证书、写回文件或将证书与私钥存入数据库。
缺失或无效时，管理后台「系统设置 → 面板证书」会显示具体原因和文件路径。

开发者可在自己的安全环境执行以下命令，再上传文件；也可以使用自有 CA 签发的客户端证书：

```bash
umask 077
openssl req -x509 -newkey rsa:3072 -sha256 -noenc -days 3650 \
  -subj "/CN=paledove-panel/O=PaleDove" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=clientAuth" \
  -keyout client.key -out client.crt
chmod 600 client.key
chmod 644 client.crt
```

运行服务的账号必须有读取权限；目录不要放在前端静态目录中，也不要提交证书或私钥到版本库。
此目录中的实际证书文件已加入项目 `.gitignore`。

可通过 `server/.env` 的 `INCUS_CERT_DIR` 使用其他目录。相对路径以 `server` 为基准，源码运行与生产构建使用同一规则。
API 与 Worker 拆分部署时，各进程必须读取同一对证书；容器部署可只读挂载目录。
替换文件后，后续 Incus / Caddy 连接会自动重新加载，无须通过网页上传。
轮换前须让全部宿主机的 Incus / Caddy 信任新证书，轮换期间应先暂停相关节点操作，完成两个文件的替换再恢复。

旧版本数据库中的 `incus.clientCertificate` 不再被读取，也不会自动导出。
升级前如需保留现有宿主机信任，应在旧版本中自行导出原证书与私钥，分别保存为上述文件；完成备份与连通性验证后，可由数据库维护人员清理旧记录。
