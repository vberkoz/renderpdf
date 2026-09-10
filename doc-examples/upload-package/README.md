# Upload package example

`renderpdf-upload-package.zip` is the archive to send to `POST /api/v1/files/upload`.
It contains this directory's `index.html` and local SVG asset.

Rebuild it after changing the source files:

```bash
cd /Users/basilsergius/projects/renderpdf/doc-examples/upload-package
zip -r ../renderpdf-upload-package.zip index.html assets
```
