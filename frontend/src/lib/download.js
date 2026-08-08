export function saveBrowserDownload(
  { blob, filename },
  { documentRef = document, urlApi = URL, schedule = setTimeout } = {}
) {
  const objectUrl = urlApi.createObjectURL(blob);
  const link = documentRef.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.style.display = 'none';
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
  schedule(() => urlApi.revokeObjectURL(objectUrl), 0);
}
