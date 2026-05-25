# Murmur model library downloads

Tags: murmur, tauri, model-management, app-data, desktop-ux

## Lesson

สำหรับ Murmur ให้ถือว่า whisper model เป็น **app-owned data** เท่านั้น: catalog, discovery, selected model, download, uninstall และ auto-select ควรอิง `app.path().app_data_dir()?.join("models")` ไม่ควร fallback ไป `~/.whisper`, Superwhisper, `whisper.cpp/models`, หรือ `MAHIRO_WHISPER_MODEL` โดยอัตโนมัติ เพราะทำให้ ownership และ uninstall behavior สับสน  `whisper-cli` และ `ffmpeg` ยัง detect จากระบบได้ เพราะเป็น binary/tool ไม่ใช่ model asset

Model UI ควรแสดงทั้ง label ที่อ่านง่ายและ filename/path จริง เช่น `Whisper Base` + `ggml-base.bin` หรือ path เต็มเมื่อ installed แล้ว  จัด group เป็น `Multilingual` และ `English only` ช่วย scan ได้ดีกว่ารายการเดียว

Tauri invoke naming สำคัญ: Rust arg `model_id` ต้องเรียกจาก JS เป็น `{ modelId }`  ถ้าส่ง `{ model_id: ... }` command จะดูเหมือนปุ่มไม่ทำงาน

Download model ขนาดใหญ่ห้ามใช้ sync/blocking command ตรง ๆ แม้จะ emit progress แล้ว UI ก็อาจไม่ render เพราะ event loop ถูก block  Pattern ที่ควรใช้: `async fn download_model(...)` แล้ว `tauri::async_runtime::spawn_blocking(move || download_model_blocking(...))`; backend อ่าน response เป็น chunk, emit `model-download-progress`, UI listen event แล้วแสดง `%`, downloaded bytes และ progress bar

## Follow-up checklist

- Manual QA `Tiny/Base` download ใน `pnpm tauri dev`
- Verify app data path และไฟล์จริงหลัง download/uninstall
- ถ้าเพิ่ม large models ให้ระวังไฟล์ 1-3GB ต้องมี progress/cancel/retry ที่ชัด
- อย่าเรียก build pass ว่า UX pass จนกว่าจะลองกดใน desktop runtime จริง
