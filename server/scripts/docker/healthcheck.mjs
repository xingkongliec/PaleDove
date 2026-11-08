// Worker 单独运行时没有 HTTP 监听；API 容器检查自身健康端点。
if (process.env.RUN_API === 'false') process.exit(0);
try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`, { signal: AbortSignal.timeout(4000) });
  const body = response.ok ? await response.json() : null;
  if (!body?.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
