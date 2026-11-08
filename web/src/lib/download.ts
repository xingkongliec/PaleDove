/** 把文本保存为本地文件（浏览器下载） */
export function downloadText(filename: string, content: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // 下载已在点击时开始，稍后释放即可
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
