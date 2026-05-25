# Murmur

**Murmur** อ่านว่า **เมอร์-เมอร์** — เหมือนเสียงพูดเบา ๆ หรือเสียงพึมพำใกล้ตัว

ชื่อนี้ตั้งใจให้เข้ากับแอป dictation ที่อยู่เงียบ ๆ บน macOS กดปุ่ม พูด แล้วปล่อยให้เครื่องถอดเสียงให้โดยไม่ต้องส่งเสียงหรือไฟล์ออกไปที่บริการภายนอก

Murmur เป็นแอป dictation สำหรับ macOS ที่ใช้ **Tauri v2**, **React**, **Rust**, **CoreAudio/CPAL** และ **whisper.cpp** เพื่ออัดเสียง ถอดเสียงในเครื่อง คัดลอกข้อความ แล้ว paste กลับไปยังแอปที่กำลังใช้อยู่

> สถานะโปรเจกต์: early alpha / personal tool ที่กำลังขยับให้เปิดอ่านและต่อยอดได้ง่ายขึ้น ตอนนี้โฟกัส macOS ก่อนเป็นหลัก

## ทำอะไรได้บ้าง

- กด global shortcut เพื่อเริ่ม/หยุดอัดเสียงจากแอปไหนก็ได้
- ถอดเสียงด้วย `whisper.cpp` บนเครื่อง ไม่ต้องส่งเสียงขึ้น cloud
- รองรับการพูดไทยปนอังกฤษ โดยตั้ง prompt ให้คงชื่อ product, technical terms และคำอังกฤษไว้
- copy transcript เข้า clipboard และ auto-paste กลับไปยังแอปที่ใช้อยู่
- มี floating indicator สำหรับสถานะ Recording / Transcribing / Pasting
- มี settings window สำหรับเลือกภาษา output mode และจัดการ model
- มี model library สำหรับดาวน์โหลด/จัดการ `ggml*.bin` models ใน app data
- เก็บ history ไว้ในเครื่องผ่าน `localStorage`

## หน้าตาโดยรวม

Murmur ตั้งใจเป็นแอปเล็ก ๆ ที่ไม่แย่งพื้นที่หน้าจอ

- **Main window** — control surface ขนาดกะทัดรัด สำหรับเริ่ม dictation และเลือก mode
- **Settings window** — หน้าตั้งค่าแบบ sidebar แยกจากหน้าหลัก
- **Indicator window** — pill ลอยเล็ก ๆ ที่แสดงสถานะระหว่างอัดเสียงและถอดเสียง
- **Tray / menu bar** — จุดเข้าใช้งานหลักบน macOS

## Tech stack

- Tauri v2
- Rust
- React 19 + TypeScript + Vite
- CPAL สำหรับ native audio recording
- hound สำหรับเขียน WAV
- arboard สำหรับ clipboard Unicode
- CoreGraphics สำหรับ auto-paste บน macOS
- whisper.cpp / `whisper-cli` สำหรับ speech-to-text

## Requirements

ตอนนี้ Murmur พัฒนาและทดสอบบน macOS เป็นหลัก

- macOS
- Node.js + pnpm
- Rust + Cargo
- Tauri v2 prerequisites
- `whisper-cli` จาก whisper.cpp
- whisper model แบบ `ggml*.bin`

ถ้า Murmur หา binary หรือ model ไม่เจอ สามารถตั้ง path เองได้

```sh
export MAHIRO_WHISPER_CLI=/opt/homebrew/bin/whisper-cli
export MAHIRO_FFMPEG=/opt/homebrew/bin/ffmpeg
export MAHIRO_WHISPER_MODEL=$HOME/.whisper/ggml-base.bin
```

> หมายเหตุ: flow หลักตอนนี้ใช้ native CPAL recording แล้ว แต่ `ffmpeg` ยังมีประโยชน์กับบาง path/เครื่องมือเดิมในโปรเจกต์

## Quick start

```sh
pnpm install
pnpm build
cd src-tauri && cargo check
cd ..
pnpm tauri dev
```

คำสั่งที่ใช้บ่อย

```sh
pnpm build                 # typecheck frontend + build Vite
cd src-tauri && cargo check
cd src-tauri && cargo fmt --check
pnpm tauri build --debug
```

## วิธีใช้งานแบบสั้น

1. เปิด Murmur
2. ตั้งค่า model ใน Settings หรือให้แอปใช้ model ที่พบในเครื่อง
3. กด `Option + Space` เพื่อเริ่มอัดเสียง
4. กด `Option + Space` อีกครั้งเพื่อหยุด
5. Murmur จะถอดเสียง copy ข้อความ และ paste กลับไปยังแอปเดิมตาม output mode ที่ตั้งไว้

ถ้า auto-paste ไม่ทำงาน ให้เปิด macOS System Settings แล้วให้ Accessibility permission กับ Murmur

## macOS permissions

Murmur ต้องใช้ permission บางอย่างเพื่อให้ dictation flow ลื่นจริง

- **Microphone** — ใช้อัดเสียง
- **Accessibility** — ใช้ส่ง `Cmd+V` กลับไปยังแอปที่ active อยู่
- **Global shortcut** — อาจชนกับ shortcut ของ macOS หรือแอปอื่นได้

## Privacy

Murmur ออกแบบเป็น local-first

- แอปอัดเสียงและถอดเสียงบนเครื่อง
- transcript history เก็บในเครื่อง
- model อยู่ใน app data หรือ path ที่ผู้ใช้เลือก
- ไม่มี server ฝั่งโปรเจกต์นี้สำหรับรับเสียงหรือ transcript

แต่ถ้าคุณเพิ่ม integration ใหม่ เช่น cloud transcription, sync, analytics หรือ crash reporting ควรระบุให้ชัดใน README และ UI ก่อนเปิดใช้จริง

## Project structure

```txt
src/
  App.tsx        # UI หลัก แยกตาม Tauri window label
  App.css        # custom window chrome, settings, indicator styling

src-tauri/
  src/lib.rs     # native recording, tray, shortcut, whisper, clipboard, windows
  tauri.conf.json
  capabilities/default.json

docs/
  plan.md
  development.md
```

## Development notes

อ่านเพิ่มได้ที่

- [docs/plan.md](docs/plan.md) — product/architecture plan
- [docs/development.md](docs/development.md) — local setup, current flow, debugging notes

ถ้าจะช่วยพัฒนา แนะนำให้เช็กสองฝั่งเสมอ

```sh
pnpm build
cd src-tauri && cargo check
```

ถ้าแตะ Tauri config, permissions, window labels, tray, global shortcut หรือ native recording ควรลอง `pnpm tauri build --debug` และ manual QA บน macOS ด้วย เพราะ build ผ่านไม่ได้แปลว่า window/permission behavior ถูกทั้งหมด

## Known limitations

- macOS-first ยังไม่ได้ออกแบบ cross-platform จริงจัง
- ยังเป็น early alpha API/UX อาจเปลี่ยนได้
- auto-paste ต้องพึ่ง Accessibility permission ของ macOS
- global shortcut อาจชนกับแอปอื่น
- ยังไม่มี automated test suite ใน repo นี้

## Contributing

ยินดีรับ issue, idea และ pull request โดยเฉพาะเรื่องเหล่านี้

- bug จาก macOS permission / shortcut / tray behavior
- model discovery และ model download UX
- Thai + English dictation quality
- indicator/window behavior บนหลายหน้าจอ
- docs ที่ช่วยให้ setup ง่ายขึ้น

ก่อนส่ง PR รบกวนรันอย่างน้อย

```sh
pnpm build
cd src-tauri && cargo check
```

ถ้าปรับโค้ด Rust และอยากเช็ก formatting ด้วย ให้รัน

```sh
cd src-tauri && cargo fmt --check
```

## License

Murmur เปิดภายใต้ [MIT License](LICENSE)
