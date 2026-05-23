use std::{
    collections::BTreeSet,
    env,
    fs::{self, File},
    io::BufWriter,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Size, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

#[derive(Debug, Serialize)]
struct WhisperStatus {
    available: bool,
    binary_path: Option<String>,
    model_path: Option<String>,
    ffmpeg_path: Option<String>,
    version: Option<String>,
    message: String,
}

#[derive(Debug, Serialize)]
struct ModelInfo {
    name: String,
    path: String,
    multilingual: bool,
    source: String,
}

#[derive(Debug, Serialize)]
struct TranscriptionResult {
    transcript: String,
    raw_audio_path: String,
    wav_path: String,
    model_path: String,
    whisper_binary_path: String,
}

type WavWriterHandle = Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>>;
type AudioLevelThrottle = Arc<Mutex<u128>>;

struct NativeRecording {
    wav_path: PathBuf,
    stream: cpal::Stream,
    writer: WavWriterHandle,
}

// CPAL's CoreAudio stream is intentionally conservative about Send on macOS.
// We keep it behind app state only to hold/drop the live stream across shortcut events.
unsafe impl Send for NativeRecording {}

#[derive(Debug, Clone, Deserialize)]
struct NativePreferences {
    language: String,
    model_path: Option<String>,
    output_mode: String,
}

impl Default for NativePreferences {
    fn default() -> Self {
        Self {
            language: "th".to_string(),
            model_path: None,
            output_mode: "paste".to_string(),
        }
    }
}

#[derive(Default)]
struct NativeRecorderState {
    recording: Mutex<Option<NativeRecording>>,
    preferences: Mutex<NativePreferences>,
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn path_exists(path: &str) -> bool {
    Path::new(path).exists()
}

fn command_available(candidate: &str, arg: &str) -> bool {
    Command::new(candidate)
        .arg(arg)
        .output()
        .map(|output| output.status.success() || !output.stdout.is_empty() || !output.stderr.is_empty())
        .unwrap_or(false)
}

fn whisper_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    if let Ok(path) = env::var("MAHIRO_WHISPER_CLI") {
        candidates.push(path);
    }

    candidates.extend([
        "/opt/homebrew/bin/whisper-cli".to_string(),
        "/usr/local/bin/whisper-cli".to_string(),
        "whisper-cli".to_string(),
    ]);

    candidates
}

fn ffmpeg_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    if let Ok(path) = env::var("MAHIRO_FFMPEG") {
        candidates.push(path);
    }

    candidates.extend([
        "/opt/homebrew/bin/ffmpeg".to_string(),
        "/usr/local/bin/ffmpeg".to_string(),
        "ffmpeg".to_string(),
    ]);

    candidates
}

fn model_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    if let Ok(path) = env::var("MAHIRO_WHISPER_MODEL") {
        candidates.push(path);
    }

    if let Some(home) = home_dir() {
        candidates.extend([
            home.join("Library/Application Support/superwhisper/ggml-small.bin"),
            home.join("Library/Application Support/superwhisper/ggml-medium.en.bin"),
            home.join(".whisper/ggml-base.en.bin"),
            home.join("ghq/github.com/ggml-org/whisper.cpp/models/ggml-small.bin"),
            home.join("ghq/github.com/ggml-org/whisper.cpp/models/ggml-base.bin"),
        ]
        .into_iter()
        .map(|path| path.to_string_lossy().to_string()));
    }

    candidates
}

fn find_whisper_binary() -> Option<String> {
    whisper_candidates()
        .into_iter()
        .find(|candidate| path_exists(candidate) || command_available(candidate, "--help"))
}

fn find_ffmpeg_binary() -> Option<String> {
    ffmpeg_candidates()
        .into_iter()
        .find(|candidate| path_exists(candidate) || command_available(candidate, "-version"))
}

fn model_search_dirs() -> Vec<(String, PathBuf)> {
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        dirs.extend([
            ("Superwhisper".to_string(), home.join("Library/Application Support/superwhisper")),
            ("~/.whisper".to_string(), home.join(".whisper")),
            ("whisper.cpp".to_string(), home.join("ghq/github.com/ggml-org/whisper.cpp/models")),
        ]);
    }
    dirs
}

fn discover_models() -> Vec<ModelInfo> {
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();

    for path in model_candidates() {
        if path_exists(&path) && seen.insert(path.clone()) {
            let name = Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            models.push(ModelInfo {
                multilingual: !name.ends_with(".en.bin"),
                name,
                path,
                source: "candidate".to_string(),
            });
        }
    }

    for (source, dir) in model_search_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else { continue; };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(file_name) = path.file_name().map(|name| name.to_string_lossy().to_string()) else { continue; };
            if !file_name.starts_with("ggml") || !file_name.ends_with(".bin") {
                continue;
            }
            let path_string = path.to_string_lossy().to_string();
            if seen.insert(path_string.clone()) {
                models.push(ModelInfo {
                    multilingual: !file_name.ends_with(".en.bin"),
                    name: file_name,
                    path: path_string,
                    source: source.clone(),
                });
            }
        }
    }

    models.sort_by(|a, b| {
        b.multilingual
            .cmp(&a.multilingual)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.path.cmp(&b.path))
    });

    models
}

fn find_model_path(preferred: Option<String>) -> Option<String> {
    preferred
        .into_iter()
        .chain(model_candidates())
        .find(|candidate| path_exists(candidate))
}

fn find_model_path_for_language(preferred: Option<String>, language: &str) -> Option<String> {
    if let Some(preferred) = preferred.filter(|path| !path.trim().is_empty()) {
        return path_exists(&preferred).then_some(preferred);
    }

    let candidates = model_candidates();

    if language != "en" {
        if let Some(path) = candidates
            .iter()
            .find(|candidate| path_exists(candidate) && !candidate.ends_with(".en.bin"))
        {
            return Some(path.clone());
        }
    }

    candidates.into_iter().find(|candidate| path_exists(candidate))
}

fn probe_whisper(candidate: &str) -> Option<String> {
    let output = Command::new(candidate).arg("--help").output().ok()?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    if !output.status.success() && combined.trim().is_empty() {
        return None;
    }

    combined
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

fn extension_from_mime(mime_type: Option<&str>) -> &'static str {
    match mime_type.unwrap_or_default() {
        value if value.contains("wav") => "wav",
        value if value.contains("mp4") || value.contains("m4a") => "m4a",
        value if value.contains("ogg") => "ogg",
        value if value.contains("mpeg") || value.contains("mp3") => "mp3",
        _ => "webm",
    }
}

fn clean_transcript(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with("whisper_"))
        .filter(|line| !line.starts_with("ggml_"))
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn wav_spec_from_config(config: &cpal::SupportedStreamConfig) -> hound::WavSpec {
    hound::WavSpec {
        channels: config.channels(),
        sample_rate: config.sample_rate().0,
        bits_per_sample: (config.sample_format().sample_size() * 8) as u16,
        sample_format: if config.sample_format().is_float() {
            hound::SampleFormat::Float
        } else {
            hound::SampleFormat::Int
        },
    }
}

fn emit_audio_level<T>(input: &[T], app: &AppHandle, last_emit: &AudioLevelThrottle)
where
    T: Sample,
    f32: FromSample<T>,
{
    let now = timestamp_ms();
    let should_emit = if let Ok(mut last_emit) = last_emit.try_lock() {
        if now.saturating_sub(*last_emit) < 40 {
            false
        } else {
            *last_emit = now;
            true
        }
    } else {
        false
    };

    if !should_emit || input.is_empty() {
        return;
    }

    let sum = input.iter().fold(0.0_f32, |acc, &sample| {
        let sample = f32::from_sample(sample).clamp(-1.0, 1.0);
        acc + sample * sample
    });
    let rms = (sum / input.len() as f32).sqrt();
    let level = (rms * 8.0).clamp(0.0, 1.0);
    let _ = app.emit("audio-level", level);
}

fn write_input_data<T, U>(input: &[T], writer: &WavWriterHandle, app: &AppHandle, last_emit: &AudioLevelThrottle)
where
    T: Sample,
    U: Sample + hound::Sample + FromSample<T>,
    f32: FromSample<T>,
{
    emit_audio_level(input, app, last_emit);

    if let Ok(mut guard) = writer.try_lock() {
        if let Some(writer) = guard.as_mut() {
            for &sample in input.iter() {
                let sample: U = U::from_sample(sample);
                let _ = writer.write_sample(sample);
            }
        }
    }
}

fn set_clipboard_text(text: &str) -> Result<(), String> {
    // Use a native Unicode clipboard writer instead of `pbcopy`.
    // `pbcopy` can inherit a non-UTF-8 locale from the app process and turn Thai
    // into mojibake such as `‡πÇ...`.
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|error| format!("เปิด clipboard ไม่สำเร็จ: {error}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|error| format!("เขียน clipboard ไม่สำเร็จ: {error}"))
}

fn effective_language(language: &str) -> &str {
    match language {
        "mixed-th-en" => "th",
        value => value,
    }
}

fn language_prompt(language: &str) -> Option<&'static str> {
    match language {
        "mixed-th-en" => Some("ถอดเสียงเป็นภาษาไทยตามที่พูด คงคำศัพท์ภาษาอังกฤษ ชื่อ product ชื่อเครื่องมือ และ technical terms เป็นภาษาอังกฤษ เช่น Tauri, whisper.cpp, API, model, shortcut"),
        "th" => Some("ถอดเสียงเป็นภาษาไทย คงคำศัพท์ภาษาอังกฤษและ technical terms เป็นภาษาอังกฤษตามที่พูด"),
        _ => None,
    }
}

fn transcribe_wav_file(wav_path: &Path, language: &str, model_path: Option<String>) -> Result<String, String> {
    let whisper_binary = find_whisper_binary().ok_or_else(|| {
        "ยังไม่พบ whisper-cli ตั้งค่า MAHIRO_WHISPER_CLI หรือ install whisper.cpp ก่อน".to_string()
    })?;
    let effective_language = effective_language(language);
    let model_path = find_model_path_for_language(model_path, effective_language)
        .ok_or_else(|| "ยังไม่พบ whisper model ตั้งค่า MAHIRO_WHISPER_MODEL ก่อน".to_string())?;

    let transcript_base = wav_path.with_extension("");
    let transcript_txt_path = transcript_base.with_extension("txt");

    let mut command = Command::new(&whisper_binary);
    command.args([
        "-m",
        model_path.as_str(),
        "-f",
        wav_path.to_string_lossy().as_ref(),
        "-l",
        effective_language,
        "-nt",
        "-np",
        "-otxt",
        "-of",
        transcript_base.to_string_lossy().as_ref(),
    ]);

    if let Some(prompt) = language_prompt(language) {
        command.args(["--prompt", prompt]);
    }

    let whisper_output = command
        .output()
        .map_err(|error| format!("เรียก whisper.cpp ไม่สำเร็จ: {error}"))?;

    if !whisper_output.status.success() {
        return Err(format!(
            "whisper.cpp transcribe ไม่สำเร็จ: {}{}",
            String::from_utf8_lossy(&whisper_output.stdout),
            String::from_utf8_lossy(&whisper_output.stderr)
        ));
    }

    let transcript_from_file = fs::read_to_string(&transcript_txt_path).unwrap_or_default();
    let transcript_from_stdout = String::from_utf8_lossy(&whisper_output.stdout).to_string();
    let transcript_source = if transcript_from_file.trim().is_empty() {
        transcript_from_stdout.as_str()
    } else {
        transcript_from_file.as_str()
    };
    let transcript = clean_transcript(transcript_source);

    if transcript.is_empty() {
        Err("transcribe เสร็จแล้ว แต่ยังไม่ได้ข้อความกลับมา".to_string())
    } else {
        Ok(transcript)
    }
}

#[tauri::command]
fn list_available_models() -> Vec<ModelInfo> {
    discover_models()
}

#[tauri::command]
fn get_whisper_status() -> WhisperStatus {
    let whisper_binary = find_whisper_binary();
    let model_path = find_model_path(None);
    let ffmpeg_path = find_ffmpeg_binary();
    let version = whisper_binary
        .as_deref()
        .and_then(probe_whisper);

    let available = whisper_binary.is_some() && model_path.is_some() && ffmpeg_path.is_some();
    let message = match (&whisper_binary, &model_path, &ffmpeg_path) {
        (Some(_), Some(_), Some(_)) => "พร้อมใช้งาน: พบ whisper.cpp, model และ ffmpeg แล้ว".to_string(),
        (None, _, _) => "ยังไม่พบ whisper-cli ตั้งค่า MAHIRO_WHISPER_CLI หรือวาง binary ใน /opt/homebrew/bin".to_string(),
        (_, None, _) => "ยังไม่พบ whisper model ตั้งค่า MAHIRO_WHISPER_MODEL หรือวาง model ใน ~/.whisper".to_string(),
        (_, _, None) => "ยังไม่พบ ffmpeg สำหรับแปลงเสียงจาก browser recorder เป็น wav".to_string(),
    };

    WhisperStatus {
        available,
        binary_path: whisper_binary,
        model_path,
        ffmpeg_path,
        version,
        message,
    }
}

#[tauri::command]
fn get_app_plan() -> Vec<&'static str> {
    vec![
        "Option + Space เริ่ม/หยุด dictation",
        "บันทึกเสียงจาก microphone ผ่าน browser recorder",
        "แปลงเสียงเป็น WAV ด้วย ffmpeg",
        "ส่ง WAV เข้า whisper.cpp แล้ว copy transcript",
        "ต่อยอด auto-paste/history/editor หลัง MVP เสถียร",
    ]
}

#[tauri::command]
fn show_indicator(app: AppHandle, state: String) -> Result<(), String> {
    const INDICATOR_WIDTH: f64 = 430.0;
    const INDICATOR_HEIGHT: f64 = 124.0;

    let window = app
        .get_webview_window("indicator")
        .ok_or_else(|| "indicator window not found".to_string())?;

    let _ = window.set_size(Size::Logical(LogicalSize::new(
        INDICATOR_WIDTH,
        INDICATOR_HEIGHT,
    )));

    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| app.available_monitors().ok().and_then(|mut monitors| monitors.pop()));

    if let Some(monitor) = monitor {
        let scale_factor = monitor.scale_factor();
        let size = monitor.size();
        let position = monitor.position();

        let window_width = (INDICATOR_WIDTH * scale_factor) as i32;
        let x = position.x + ((size.width as i32 - window_width) / 2);
        let y = position.y + (28.0 * scale_factor) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }

    let _ = window.set_focusable(false);
    let _ = window.set_always_on_top(true);
    window.show().map_err(|error| error.to_string())?;

    let _ = app.emit("indicator-state", state.clone());
    let _ = window.emit("indicator-state", state.clone());

    let app_for_delayed_emit = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        let _ = app_for_delayed_emit.emit("indicator-state", state);
    });

    Ok(())
}

#[tauri::command]
fn hide_indicator(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("indicator") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn paste_clipboard() -> Result<(), String> {
    // Keycode 9 is `V` on the macOS virtual keycode map.
    // Sending Cmd+V with CGEvent keeps paste owned by this app instead of delegating
    // to System Events / AppleScript, which is less reliable for background dictation.
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "สร้าง CGEventSource ไม่สำเร็จ".to_string())?;
    let key_down = CGEvent::new_keyboard_event(source.clone(), 9, true)
        .map_err(|_| "สร้าง Cmd+V key down ไม่สำเร็จ".to_string())?;
    let key_up = CGEvent::new_keyboard_event(source, 9, false)
        .map_err(|_| "สร้าง Cmd+V key up ไม่สำเร็จ".to_string())?;

    key_down.set_flags(CGEventFlags::CGEventFlagCommand);
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);
    key_down.post(CGEventTapLocation::Session);
    key_up.post(CGEventTapLocation::Session);

    Ok(())
}

#[tauri::command]
fn set_native_preferences(app: AppHandle, preferences: NativePreferences) -> Result<(), String> {
    let state = app.state::<NativeRecorderState>();
    let mut guard = state
        .preferences
        .lock()
        .map_err(|_| "native preferences lock failed".to_string())?;

    *guard = NativePreferences {
        language: if preferences.language.trim().is_empty() {
            "th".to_string()
        } else {
            preferences.language
        },
        model_path: preferences.model_path.filter(|path| !path.trim().is_empty()),
        output_mode: preferences.output_mode,
    };

    Ok(())
}

#[tauri::command]
fn transcribe_audio(
    app: AppHandle,
    audio: Vec<u8>,
    mime_type: Option<String>,
    language: Option<String>,
    model_path: Option<String>,
) -> Result<TranscriptionResult, String> {
    if audio.is_empty() {
        return Err("ยังไม่มี audio data สำหรับ transcribe".to_string());
    }

    let whisper_binary = find_whisper_binary().ok_or_else(|| {
        "ยังไม่พบ whisper-cli ตั้งค่า MAHIRO_WHISPER_CLI หรือ install whisper.cpp ก่อน".to_string()
    })?;
    let ffmpeg_binary = find_ffmpeg_binary()
        .ok_or_else(|| "ยังไม่พบ ffmpeg สำหรับแปลงไฟล์เสียงเป็น WAV".to_string())?;
    let model_path = find_model_path(model_path)
        .ok_or_else(|| "ยังไม่พบ whisper model ตั้งค่า MAHIRO_WHISPER_MODEL ก่อน".to_string())?;

    let recordings_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("recordings");
    fs::create_dir_all(&recordings_dir).map_err(|error| error.to_string())?;

    let stamp = timestamp_ms();
    let raw_extension = extension_from_mime(mime_type.as_deref());
    let raw_path = recordings_dir.join(format!("dictation-{stamp}.{raw_extension}"));
    let wav_path = recordings_dir.join(format!("dictation-{stamp}.wav"));
    let transcript_base = recordings_dir.join(format!("dictation-{stamp}"));
    let transcript_txt_path = recordings_dir.join(format!("dictation-{stamp}.txt"));

    fs::write(&raw_path, audio).map_err(|error| error.to_string())?;

    let ffmpeg_output = Command::new(&ffmpeg_binary)
        .args([
            "-y",
            "-i",
            raw_path.to_string_lossy().as_ref(),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            wav_path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|error| format!("เรียก ffmpeg ไม่สำเร็จ: {error}"))?;

    if !ffmpeg_output.status.success() {
        return Err(format!(
            "ffmpeg แปลงเสียงไม่สำเร็จ: {}",
            String::from_utf8_lossy(&ffmpeg_output.stderr)
        ));
    }

    let language = language.unwrap_or_else(|| "auto".to_string());
    let whisper_output = Command::new(&whisper_binary)
        .args([
            "-m",
            model_path.as_str(),
            "-f",
            wav_path.to_string_lossy().as_ref(),
            "-l",
            language.as_str(),
            "-nt",
            "-np",
            "-otxt",
            "-of",
            transcript_base.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|error| format!("เรียก whisper.cpp ไม่สำเร็จ: {error}"))?;

    if !whisper_output.status.success() {
        return Err(format!(
            "whisper.cpp transcribe ไม่สำเร็จ: {}{}",
            String::from_utf8_lossy(&whisper_output.stdout),
            String::from_utf8_lossy(&whisper_output.stderr)
        ));
    }

    let transcript_from_file = fs::read_to_string(&transcript_txt_path).unwrap_or_default();
    let transcript_from_stdout = String::from_utf8_lossy(&whisper_output.stdout).to_string();
    let transcript_source = if transcript_from_file.trim().is_empty() {
        transcript_from_stdout.as_str()
    } else {
        transcript_from_file.as_str()
    };
    let transcript = clean_transcript(transcript_source);

    if transcript.is_empty() {
        return Err("transcribe เสร็จแล้ว แต่ยังไม่ได้ข้อความกลับมา".to_string());
    }

    Ok(TranscriptionResult {
        transcript,
        raw_audio_path: raw_path.to_string_lossy().to_string(),
        wav_path: wav_path.to_string_lossy().to_string(),
        model_path,
        whisper_binary_path: whisper_binary,
    })
}

fn start_native_recording(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<NativeRecorderState>();
    let mut recording_guard = state
        .recording
        .lock()
        .map_err(|_| "recording state lock failed".to_string())?;

    if recording_guard.is_some() {
        return Ok(());
    }

    let recordings_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("recordings");
    fs::create_dir_all(&recordings_dir).map_err(|error| error.to_string())?;
    let wav_path = recordings_dir.join(format!("native-dictation-{}.wav", timestamp_ms()));

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "ไม่พบ input microphone device".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|error| format!("อ่านค่า microphone config ไม่สำเร็จ: {error}"))?;

    let spec = wav_spec_from_config(&config);
    let writer = hound::WavWriter::create(&wav_path, spec)
        .map_err(|error| format!("สร้างไฟล์ WAV ไม่สำเร็จ: {error}"))?;
    let writer = Arc::new(Mutex::new(Some(writer)));
    let writer_for_stream = writer.clone();
    let audio_level_throttle: AudioLevelThrottle = Arc::new(Mutex::new(0));
    let err_fn = |error| eprintln!("audio input stream error: {error}");

    let stream = match config.sample_format() {
        cpal::SampleFormat::I8 => {
            let app = app.clone();
            let last_emit = audio_level_throttle.clone();
            device.build_input_stream(
                &config.clone().into(),
                move |data, _: &_| write_input_data::<i8, i8>(data, &writer_for_stream, &app, &last_emit),
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let app = app.clone();
            let last_emit = audio_level_throttle.clone();
            device.build_input_stream(
                &config.clone().into(),
                move |data, _: &_| write_input_data::<i16, i16>(data, &writer_for_stream, &app, &last_emit),
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I32 => {
            let app = app.clone();
            let last_emit = audio_level_throttle.clone();
            device.build_input_stream(
                &config.clone().into(),
                move |data, _: &_| write_input_data::<i32, i32>(data, &writer_for_stream, &app, &last_emit),
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::F32 => {
            let app = app.clone();
            let last_emit = audio_level_throttle.clone();
            device.build_input_stream(
                &config.clone().into(),
                move |data, _: &_| write_input_data::<f32, f32>(data, &writer_for_stream, &app, &last_emit),
                err_fn,
                None,
            )
        }
        sample_format => return Err(format!("microphone sample format ยังไม่รองรับ: {sample_format}")),
    }
    .map_err(|error| format!("เริ่ม audio input stream ไม่สำเร็จ: {error}"))?;

    stream
        .play()
        .map_err(|error| format!("เปิด microphone stream ไม่สำเร็จ: {error}"))?;

    *recording_guard = Some(NativeRecording { wav_path, stream, writer });


    let _ = app.emit("dictation-state", "recording");
    let _ = show_indicator(app.clone(), "Recording".to_string());
    Ok(())
}

fn finish_native_recording(recording: NativeRecording, app: AppHandle, preferences: NativePreferences) {
    drop(recording.stream);
    let finalize_result = recording
        .writer
        .lock()
        .map_err(|_| "recording writer lock failed".to_string())
        .and_then(|mut guard| {
            if let Some(writer) = guard.take() {
                writer
                    .finalize()
                    .map_err(|error| format!("ปิดไฟล์ WAV ไม่สำเร็จ: {error}"))?;
            }
            Ok(())
        });

    let result = finalize_result
        .and_then(|_| {
            transcribe_wav_file(
                &recording.wav_path,
                preferences.language.as_str(),
                preferences.model_path.clone(),
            )
        })
        .and_then(|transcript| {
            set_clipboard_text(&transcript)?;
            if preferences.output_mode == "paste" {
                let _ = app.emit("dictation-state", "pasting");
                let _ = show_indicator(app.clone(), "Pasting".to_string());
                std::thread::sleep(std::time::Duration::from_millis(420));
                paste_clipboard()?;
            }
            Ok(transcript)
        });

    match result {
        Ok(transcript) => {
            let _ = app.emit("transcript-ready", transcript);
            let _ = app.emit("dictation-state", "done");
            let _ = show_indicator(app.clone(), "Done".to_string());
            std::thread::sleep(std::time::Duration::from_millis(650));
        }
        Err(error) => {
            let _ = app.emit("dictation-error", error);
            let _ = app.emit("dictation-state", "error");
            let _ = show_indicator(app.clone(), "Error".to_string());
            std::thread::sleep(std::time::Duration::from_millis(1200));
        }
    }

    let _ = hide_indicator(app);
}

fn take_native_recording(app: &AppHandle) -> Result<Option<NativeRecording>, String> {
    let state = app.state::<NativeRecorderState>();
    let recording = {
        let mut recording_guard = state
            .recording
            .lock()
            .map_err(|_| "recording state lock failed".to_string())?;
        recording_guard.take()
    };

    Ok(recording)
}

fn stop_native_recording(app: AppHandle) -> Result<(), String> {
    let Some(recording) = take_native_recording(&app)? else { return Ok(()); };
    let _ = app.emit("dictation-state", "transcribing");
    let _ = show_indicator(app.clone(), "Transcribing".to_string());

    let preferences = {
        let state = app.state::<NativeRecorderState>();
        let guard = state
            .preferences
            .lock()
            .map_err(|_| "native preferences lock failed".to_string())?;
        guard.clone()
    };

    std::thread::spawn(move || finish_native_recording(recording, app, preferences));

    Ok(())
}

#[tauri::command]
fn cancel_native_recording(app: AppHandle) -> Result<(), String> {
    let Some(recording) = take_native_recording(&app)? else { return Ok(()); };
    drop(recording.stream);
    if let Ok(mut guard) = recording.writer.lock() {
        let _ = guard.take();
    }
    let _ = fs::remove_file(&recording.wav_path);
    let _ = app.emit("dictation-state", "idle");
    let _ = hide_indicator(app);
    Ok(())
}

#[tauri::command]
fn toggle_native_recording(app: AppHandle) -> Result<(), String> {
    let is_recording = {
        let state = app.state::<NativeRecorderState>();
        let guard = state
            .recording
            .lock()
            .map_err(|_| "recording state lock failed".to_string())?;
        guard.is_some()
    };

    if is_recording { stop_native_recording(app) } else { start_native_recording(&app) }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(Size::Logical(LogicalSize::new(360.0, 430.0)));
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

fn setup_global_shortcut(app: &tauri::AppHandle) -> tauri::Result<()> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_shortcuts(["alt+space", "esc"])
            .expect("default dictation shortcut should be valid")
            .with_handler(|app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }

                if shortcut.matches(Modifiers::ALT, Code::Space) {
                    let _ = toggle_native_recording(app.clone());
                    return;
                }

                if shortcut.matches(Modifiers::empty(), Code::Escape) {
                    let is_recording = app
                        .state::<NativeRecorderState>()
                        .recording
                        .lock()
                        .map(|guard| guard.is_some())
                        .unwrap_or(false);
                    if is_recording {
                        let _ = cancel_native_recording(app.clone());
                    }
                }
            })
            .build(),
    )?;

    Ok(())
}

fn emit_tray_action(app: &tauri::AppHandle, action: &str, should_show_window: bool) {
    if should_show_window {
        show_main_window(app);
    }
    let _ = app.emit("tray-action", action);
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Toggle Recording", true, Some("Alt+Space"))?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, Some("Cmd+,"))?;
    let history = MenuItem::with_id(app, "history", "History...", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Check whisper.cpp", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Open Control Center", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("Cmd+Q"))?;
    let separator_one = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let separator_three = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &separator_one,
            &history,
            &settings,
            &status,
            &separator_two,
            &show,
            &separator_three,
            &quit,
        ],
    )?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("default app icon should exist");

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Mahiro Whisper")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => { let _ = toggle_native_recording(app.clone()); },
            "settings" => emit_tray_action(app, "settings", true),
            "history" => emit_tray_action(app, "history", true),
            "status" => emit_tray_action(app, "status", true),
            "show" => emit_tray_action(app, "home", true),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(NativeRecorderState::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            setup_tray(app)?;
            setup_global_shortcut(app.handle())?;

            let app_data_dir: PathBuf = app.path().app_data_dir()?;
            fs::create_dir_all(app_data_dir.join("recordings"))?;
            fs::create_dir_all(app_data_dir.join("models"))?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_whisper_status,
            get_app_plan,
            list_available_models,
            hide_indicator,
            hide_main_window,
            paste_clipboard,
            show_indicator,
            set_native_preferences,
            toggle_native_recording,
            cancel_native_recording,
            transcribe_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
