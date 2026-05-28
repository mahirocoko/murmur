use std::{
    collections::BTreeSet,
    env,
    fs::{self, File},
    io::{BufWriter, Read, Write},
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
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Size, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Debug, Serialize)]
struct WhisperStatus {
    available: bool,
    binary_path: Option<String>,
    model_path: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
struct ModelCatalogItem {
    id: String,
    name: String,
    file_name: String,
    multilingual: bool,
    size_mb: u32,
    quality: String,
    speed: String,
    url: String,
    installed_path: Option<String>,
    installed_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ModelDownloadProgress {
    model_id: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<f64>,
    state: String,
}

#[derive(Debug, Clone, Serialize)]
struct InputDeviceInfo {
    name: String,
    is_default: bool,
    is_selected: bool,
}

type WavWriterHandle = Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>>;
type AudioLevelThrottle = Arc<Mutex<u128>>;
const AUDIO_WAVEFORM_BARS: usize = 78;
const DEFAULT_DICTATION_SHORTCUT: &str = "alt+space";

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

struct NativeRecording {
    wav_path: PathBuf,
    stream: cpal::Stream,
    writer: WavWriterHandle,
}

// CPAL's CoreAudio stream is intentionally conservative about Send on macOS.
// We keep it behind app state only to hold/drop the live stream across shortcut events.
unsafe impl Send for NativeRecording {}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct NativePreferences {
    language: String,
    model_path: Option<String>,
    output_mode: String,
    input_device_name: Option<String>,
    shortcut: String,
}

impl Default for NativePreferences {
    fn default() -> Self {
        Self {
            language: "th".to_string(),
            model_path: None,
            output_mode: "paste".to_string(),
            input_device_name: None,
            shortcut: DEFAULT_DICTATION_SHORTCUT.to_string(),
        }
    }
}

#[derive(Default)]
struct NativeRecorderState {
    recording: Mutex<Option<NativeRecording>>,
    preferences: Mutex<NativePreferences>,
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
        .map(|output| {
            output.status.success() || !output.stdout.is_empty() || !output.stderr.is_empty()
        })
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

fn find_whisper_binary() -> Option<String> {
    whisper_candidates()
        .into_iter()
        .find(|candidate| path_exists(candidate) || command_available(candidate, "--help"))
}

fn discover_models(dirs: Vec<(String, PathBuf)>) -> Vec<ModelInfo> {
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();

    for (source, dir) in dirs {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(file_name) = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
            else {
                continue;
            };
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

fn model_catalog() -> Vec<ModelCatalogItem> {
    let base_url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

    [
        (
            "tiny",
            "Whisper Tiny",
            "ggml-tiny.bin",
            true,
            75,
            "Fastest",
            "Basic",
        ),
        (
            "base",
            "Whisper Base",
            "ggml-base.bin",
            true,
            142,
            "Fast",
            "Good",
        ),
        (
            "small",
            "Whisper Small",
            "ggml-small.bin",
            true,
            466,
            "Balanced",
            "Better",
        ),
        (
            "medium",
            "Whisper Medium",
            "ggml-medium.bin",
            true,
            1530,
            "Slower",
            "Strong",
        ),
        (
            "large-v3-turbo",
            "Whisper Large v3 Turbo",
            "ggml-large-v3-turbo.bin",
            true,
            1620,
            "Balanced",
            "Strong",
        ),
        (
            "large-v3-turbo-q5-0",
            "Whisper Large v3 Turbo Q5",
            "ggml-large-v3-turbo-q5_0.bin",
            true,
            1080,
            "Balanced",
            "Strong",
        ),
        (
            "large-v3",
            "Whisper Large v3",
            "ggml-large-v3.bin",
            true,
            3100,
            "Slow",
            "Best",
        ),
        (
            "large-v3-q5-0",
            "Whisper Large v3 Q5",
            "ggml-large-v3-q5_0.bin",
            true,
            1810,
            "Slow",
            "Best",
        ),
        (
            "tiny-en",
            "Whisper Tiny English",
            "ggml-tiny.en.bin",
            false,
            75,
            "Fastest",
            "English",
        ),
        (
            "base-en",
            "Whisper Base English",
            "ggml-base.en.bin",
            false,
            142,
            "Fast",
            "English",
        ),
        (
            "small-en",
            "Whisper Small English",
            "ggml-small.en.bin",
            false,
            466,
            "Balanced",
            "English",
        ),
    ]
    .into_iter()
    .map(
        |(id, name, file_name, multilingual, size_mb, speed, quality)| ModelCatalogItem {
            id: id.to_string(),
            name: name.to_string(),
            file_name: file_name.to_string(),
            multilingual,
            size_mb,
            speed: speed.to_string(),
            quality: quality.to_string(),
            url: format!("{base_url}/{file_name}"),
            installed_path: None,
            installed_source: None,
        },
    )
    .collect()
}

fn app_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("models"))
        .map_err(|error| error.to_string())
}

fn emit_model_download_progress(
    app: &AppHandle,
    model_id: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    state: &str,
) {
    let percent = total_bytes
        .filter(|total| *total > 0)
        .map(|total| ((downloaded_bytes as f64 / total as f64) * 100.0).clamp(0.0, 100.0));

    let _ = app.emit(
        "model-download-progress",
        ModelDownloadProgress {
            model_id: model_id.to_string(),
            downloaded_bytes,
            total_bytes,
            percent,
            state: state.to_string(),
        },
    );
}

fn discover_app_models(app: &AppHandle) -> Result<Vec<ModelInfo>, String> {
    let app_models = app_models_dir(app)?;
    Ok(discover_models(vec![("Murmur".to_string(), app_models)]))
}

fn is_path_in_app_models(app: &AppHandle, path: &str) -> bool {
    let Ok(app_models) = app_models_dir(app) else {
        return false;
    };
    let Ok(canonical_models_dir) = app_models.canonicalize() else {
        return false;
    };
    let Ok(canonical_path) = Path::new(path).canonicalize() else {
        return false;
    };
    canonical_path.starts_with(canonical_models_dir)
}

fn find_model_path_for_language(
    app: &AppHandle,
    preferred: Option<String>,
    language: &str,
) -> Option<String> {
    if let Some(preferred) = preferred.filter(|path| !path.trim().is_empty()) {
        if path_exists(&preferred) && is_path_in_app_models(app, &preferred) {
            return Some(preferred);
        }
    }

    let candidates = discover_app_models(app).ok()?;

    if language != "en" {
        if let Some(model) = candidates.iter().find(|model| model.multilingual) {
            return Some(model.path.clone());
        }
    }

    candidates.into_iter().next().map(|model| model.path)
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
        sample_rate: config.sample_rate(),
        bits_per_sample: (config.sample_format().sample_size() * 8) as u16,
        sample_format: if config.sample_format().is_float() {
            hound::SampleFormat::Float
        } else {
            hound::SampleFormat::Int
        },
    }
}

fn emit_audio_analysis<T>(input: &[T], app: &AppHandle, last_emit: &AudioLevelThrottle)
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

    let mut waveform = vec![0.0_f32; AUDIO_WAVEFORM_BARS];
    let chunk_size = (input.len() / AUDIO_WAVEFORM_BARS).max(1);
    let mut total_sum = 0.0_f32;

    for (index, chunk) in input
        .chunks(chunk_size)
        .take(AUDIO_WAVEFORM_BARS)
        .enumerate()
    {
        if chunk.is_empty() {
            continue;
        }

        let sum = chunk.iter().fold(0.0_f32, |acc, &sample| {
            let sample = f32::from_sample(sample).clamp(-1.0, 1.0);
            acc + sample * sample
        });
        total_sum += sum;

        // Use RMS per bucket so the indicator follows the real microphone input,
        // then apply a mild gain/compression curve to make normal speech visible.
        let rms = (sum / chunk.len() as f32).sqrt();
        waveform[index] = (rms * 10.0).clamp(0.0, 1.0).sqrt();
    }

    let sum = if input.len() > AUDIO_WAVEFORM_BARS * chunk_size {
        input.iter().fold(0.0_f32, |acc, &sample| {
            let sample = f32::from_sample(sample).clamp(-1.0, 1.0);
            acc + sample * sample
        })
    } else {
        total_sum
    };
    let rms = (sum / input.len() as f32).sqrt();
    let level = (rms * 8.0).clamp(0.0, 1.0);
    let _ = app.emit("audio-level", level);
    let _ = app.emit("audio-waveform", waveform);
}

fn write_input_data<T, U>(
    input: &[T],
    writer: &WavWriterHandle,
    app: &AppHandle,
    last_emit: &AudioLevelThrottle,
) where
    T: Sample,
    U: Sample + hound::Sample + FromSample<T>,
    f32: FromSample<T>,
{
    emit_audio_analysis(input, app, last_emit);

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
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("เปิด clipboard ไม่สำเร็จ: {error}"))?;
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

fn transcribe_wav_file(
    app: &AppHandle,
    wav_path: &Path,
    language: &str,
    model_path: Option<String>,
) -> Result<String, String> {
    let whisper_binary = find_whisper_binary().ok_or_else(|| {
        "ยังไม่พบ whisper-cli ตั้งค่า MAHIRO_WHISPER_CLI หรือ install whisper.cpp ก่อน".to_string()
    })?;
    let effective_language = effective_language(language);
    let model_path =
        find_model_path_for_language(app, model_path, effective_language).ok_or_else(|| {
            "ยังไม่พบ ggml model ใน Murmur app data ดาวน์โหลดจาก Models Library ก่อน".to_string()
        })?;

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
fn list_available_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let app_models = app_models_dir(&app)?;
    Ok(discover_models(vec![("Murmur".to_string(), app_models)]))
}

#[tauri::command]
fn list_model_catalog(app: AppHandle) -> Result<Vec<ModelCatalogItem>, String> {
    let app_models = app_models_dir(&app)?;
    let installed_models = discover_models(vec![("Murmur".to_string(), app_models.clone())]);

    Ok(model_catalog()
        .into_iter()
        .map(|mut item| {
            let target_path = app_models.join(&item.file_name);
            if target_path.exists() {
                item.installed_path = Some(target_path.to_string_lossy().to_string());
                item.installed_source = Some("Murmur".to_string());
            } else if let Some(model) = installed_models
                .iter()
                .find(|model| model.name == item.file_name)
            {
                item.installed_path = Some(model.path.clone());
                item.installed_source = Some(model.source.clone());
            }
            item
        })
        .collect())
}

#[tauri::command]
async fn download_model(app: AppHandle, model_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || download_model_blocking(app, model_id))
        .await
        .map_err(|error| format!("download task failed: {error}"))?
}

fn download_model_blocking(app: AppHandle, model_id: String) -> Result<String, String> {
    let catalog_item = model_catalog()
        .into_iter()
        .find(|item| item.id == model_id)
        .ok_or_else(|| "ไม่พบ model ที่เลือก".to_string())?;
    let app_models = app_models_dir(&app)?;
    fs::create_dir_all(&app_models).map_err(|error| error.to_string())?;

    let target_path = app_models.join(&catalog_item.file_name);
    if target_path.exists() {
        return Ok(target_path.to_string_lossy().to_string());
    }

    let temp_path = target_path.with_extension("bin.download");
    emit_model_download_progress(&app, &catalog_item.id, 0, None, "starting");

    let mut response = reqwest::blocking::get(&catalog_item.url)
        .map_err(|error| format!("เริ่มดาวน์โหลด model ไม่สำเร็จ: {error}"))?
        .error_for_status()
        .map_err(|error| format!("ดาวน์โหลด model ไม่สำเร็จ: {error}"))?;
    let total_bytes = response.content_length();
    let mut file = File::create(&temp_path).map_err(|error| error.to_string())?;
    let mut downloaded_bytes = 0_u64;
    let mut buffer = [0_u8; 1024 * 128];
    let mut last_emit = 0_u64;

    loop {
        let bytes_read = response
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if bytes_read == 0 {
            break;
        }

        file.write_all(&buffer[..bytes_read])
            .map_err(|error| error.to_string())?;
        downloaded_bytes += bytes_read as u64;

        if downloaded_bytes.saturating_sub(last_emit) >= 1024 * 512 {
            emit_model_download_progress(
                &app,
                &catalog_item.id,
                downloaded_bytes,
                total_bytes,
                "downloading",
            );
            last_emit = downloaded_bytes;
        }
    }

    file.flush().map_err(|error| error.to_string())?;
    emit_model_download_progress(
        &app,
        &catalog_item.id,
        downloaded_bytes,
        total_bytes,
        "finishing",
    );

    fs::rename(&temp_path, &target_path).map_err(|error| error.to_string())?;
    emit_model_download_progress(
        &app,
        &catalog_item.id,
        downloaded_bytes,
        total_bytes,
        "done",
    );
    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
fn uninstall_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let catalog_item = model_catalog()
        .into_iter()
        .find(|item| item.id == model_id)
        .ok_or_else(|| "ไม่พบ model ที่เลือก".to_string())?;
    let app_models = app_models_dir(&app)?;
    let target_path = app_models.join(&catalog_item.file_name);

    if !target_path.exists() {
        return Ok(());
    }

    let canonical_models_dir = app_models
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_target = target_path
        .canonicalize()
        .map_err(|error| error.to_string())?;

    if !canonical_target.starts_with(&canonical_models_dir) {
        return Err("ลบได้เฉพาะ model ที่ Murmur ดาวน์โหลดไว้เท่านั้น".to_string());
    }

    fs::remove_file(canonical_target).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_whisper_status(app: AppHandle) -> WhisperStatus {
    let whisper_binary = find_whisper_binary();
    let app_model_candidates = discover_app_models(&app).unwrap_or_default();
    let model_path = app_model_candidates.first().map(|model| model.path.clone());
    let version = whisper_binary.as_deref().and_then(probe_whisper);

    let available = whisper_binary.is_some() && model_path.is_some();
    let message = match (&whisper_binary, &model_path) {
        (Some(_), Some(_)) => {
            "พร้อมใช้งาน: พบ whisper.cpp และ ggml model ใน Murmur app data แล้ว".to_string()
        }
        (None, _) => {
            "ยังไม่พบ whisper-cli ตั้งค่า MAHIRO_WHISPER_CLI หรือวาง binary ใน /opt/homebrew/bin"
                .to_string()
        }
        (_, None) => {
            "ยังไม่พบ ggml model ใน Murmur app data ดาวน์โหลดจาก Models Library ก่อน".to_string()
        }
    };

    WhisperStatus {
        available,
        binary_path: whisper_binary,
        model_path,
        version,
        message,
    }
}

#[tauri::command]
fn show_indicator(app: AppHandle, state: String) -> Result<(), String> {
    const INDICATOR_WIDTH: f64 = 430.0;
    const INDICATOR_HEIGHT: f64 = 124.0;

    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.hide();
    }

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
        .or_else(|| {
            app.available_monitors()
                .ok()
                .and_then(|mut monitors| monitors.pop())
        });

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

fn get_native_preferences(app: &AppHandle) -> Result<NativePreferences, String> {
    let state = app.state::<NativeRecorderState>();
    let guard = state
        .preferences
        .lock()
        .map_err(|_| "native preferences lock failed".to_string())?;

    Ok(guard.clone())
}

fn normalize_shortcut(shortcut: String) -> String {
    let shortcut = shortcut.trim();
    if shortcut.is_empty() {
        DEFAULT_DICTATION_SHORTCUT.to_string()
    } else {
        shortcut.to_string()
    }
}

fn validate_dictation_shortcut(shortcut: &str) -> Result<(), String> {
    if !shortcut.contains('+') {
        return Err("shortcut ต้องมี modifier อย่างน้อยหนึ่งตัว".to_string());
    }

    if shortcut.eq_ignore_ascii_case("escape") || shortcut.to_ascii_lowercase().ends_with("+escape") {
        return Err("Escape ถูกใช้สำหรับยกเลิกการอัดเสียงแล้ว".to_string());
    }

    Ok(())
}

fn is_dictation_shortcut(app: &AppHandle, shortcut: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    get_native_preferences(app)
        .map(|preferences| shortcut.to_string().eq_ignore_ascii_case(&preferences.shortcut))
        .unwrap_or(false)
}

fn apply_dictation_shortcut(
    app: &AppHandle,
    previous_shortcut: Option<&str>,
    next_shortcut: &str,
) -> Result<(), String> {
    validate_dictation_shortcut(next_shortcut)?;

    if previous_shortcut
        .map(|shortcut| !shortcut.eq_ignore_ascii_case(next_shortcut))
        .unwrap_or(true)
    {
        if let Some(previous_shortcut) = previous_shortcut {
            if app.global_shortcut().is_registered(previous_shortcut) {
                app.global_shortcut()
                    .unregister(previous_shortcut)
                    .map_err(|error| format!("ยกเลิก shortcut เดิมไม่สำเร็จ: {error}"))?;
            }
        }
    }

    if !app.global_shortcut().is_registered(next_shortcut) {
        app.global_shortcut()
            .register(next_shortcut)
            .map_err(|error| format!("ลงทะเบียน shortcut ไม่สำเร็จ: {error}"))?;
    }

    Ok(())
}

#[tauri::command]
fn unregister_current_dictation_shortcut(app: AppHandle) -> Result<(), String> {
    let preferences = get_native_preferences(&app)?;
    if app.global_shortcut().is_registered(preferences.shortcut.as_str()) {
        app.global_shortcut()
            .unregister(preferences.shortcut.as_str())
            .map_err(|error| format!("พัก shortcut เดิมไม่สำเร็จ: {error}"))?;
    }

    Ok(())
}

#[tauri::command]
fn restore_current_dictation_shortcut(app: AppHandle) -> Result<(), String> {
    let preferences = get_native_preferences(&app)?;
    apply_dictation_shortcut(&app, None, preferences.shortcut.as_str())
}

#[tauri::command]
fn set_dictation_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    let state = app.state::<NativeRecorderState>();
    let previous_shortcut = {
        let guard = state
            .preferences
            .lock()
            .map_err(|_| "native preferences lock failed".to_string())?;
        guard.shortcut.clone()
    };
    let next_shortcut = normalize_shortcut(shortcut);
    apply_dictation_shortcut(&app, Some(&previous_shortcut), &next_shortcut)?;

    let mut guard = state
        .preferences
        .lock()
        .map_err(|_| "native preferences lock failed".to_string())?;
    guard.shortcut = next_shortcut;
    Ok(())
}

fn set_selected_input_device(
    app: &AppHandle,
    input_device_name: Option<String>,
) -> Result<NativePreferences, String> {
    let state = app.state::<NativeRecorderState>();
    let mut guard = state
        .preferences
        .lock()
        .map_err(|_| "native preferences lock failed".to_string())?;

    guard.input_device_name = input_device_name.filter(|name| !name.trim().is_empty());
    Ok(guard.clone())
}

fn collect_input_devices(selected_input_device_name: Option<&str>) -> Vec<InputDeviceInfo> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|device| {
        #[allow(deprecated)]
        device.name().ok()
    });
    let mut seen = BTreeSet::new();
    let mut devices = Vec::new();

    let Ok(input_devices) = host.input_devices() else {
        return devices;
    };

    for device in input_devices {
        #[allow(deprecated)]
        let Ok(name) = device.name() else {
            continue;
        };
        if !seen.insert(name.clone()) {
            continue;
        }

        let is_default = default_name.as_deref() == Some(name.as_str());
        let is_selected = selected_input_device_name
            .map(|selected_name| selected_name == name)
            .unwrap_or(is_default);

        devices.push(InputDeviceInfo {
            name,
            is_default,
            is_selected,
        });
    }

    devices.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.name.cmp(&b.name))
    });

    devices
}

fn resolve_input_device(
    host: &cpal::Host,
    selected_input_device_name: Option<&str>,
) -> Result<cpal::Device, String> {
    if let Some(selected_name) = selected_input_device_name {
        if let Ok(input_devices) = host.input_devices() {
            for device in input_devices {
                #[allow(deprecated)]
                if device.name().ok().as_deref() == Some(selected_name) {
                    return Ok(device);
                }
            }
        }
    }

    host.default_input_device()
        .ok_or_else(|| "ไม่พบ input microphone device".to_string())
}

#[tauri::command]
fn list_input_devices(app: AppHandle) -> Result<Vec<InputDeviceInfo>, String> {
    let preferences = get_native_preferences(&app)?;
    Ok(collect_input_devices(
        preferences.input_device_name.as_deref(),
    ))
}

#[tauri::command]
fn set_native_preferences(app: AppHandle, preferences: NativePreferences) -> Result<(), String> {
    let state = app.state::<NativeRecorderState>();
    let mut guard = state
        .preferences
        .lock()
        .map_err(|_| "native preferences lock failed".to_string())?;
    let previous_shortcut = guard.shortcut.clone();
    let next_shortcut = normalize_shortcut(preferences.shortcut);
    apply_dictation_shortcut(&app, Some(&previous_shortcut), &next_shortcut)?;

    let next_preferences = NativePreferences {
        language: if preferences.language.trim().is_empty() {
            "th".to_string()
        } else {
            preferences.language
        },
        model_path: preferences
            .model_path
            .filter(|path| !path.trim().is_empty()),
        output_mode: preferences.output_mode,
        input_device_name: preferences
            .input_device_name
            .filter(|name| !name.trim().is_empty()),
        shortcut: next_shortcut,
    };
    *guard = next_preferences.clone();
    drop(guard);

    let _ = app.emit(
        "input-devices-updated",
        collect_input_devices(next_preferences.input_device_name.as_deref()),
    );
    let _ = refresh_tray_menu(&app);

    Ok(())
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

    let preferences = get_native_preferences(app)?;
    let host = cpal::default_host();
    let device = resolve_input_device(&host, preferences.input_device_name.as_deref())?;
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
                move |data, _: &_| {
                    write_input_data::<i8, i8>(data, &writer_for_stream, &app, &last_emit)
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let app = app.clone();
            let last_emit = audio_level_throttle.clone();
            device.build_input_stream(
                &config.clone().into(),
                move |data, _: &_| {
                    write_input_data::<i16, i16>(data, &writer_for_stream, &app, &last_emit)
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I32 => {
            let app = app.clone();
            let last_emit = audio_level_throttle.clone();
            device.build_input_stream(
                &config.clone().into(),
                move |data, _: &_| {
                    write_input_data::<i32, i32>(data, &writer_for_stream, &app, &last_emit)
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::F32 => {
            let app = app.clone();
            let last_emit = audio_level_throttle.clone();
            device.build_input_stream(
                &config.clone().into(),
                move |data, _: &_| {
                    write_input_data::<f32, f32>(data, &writer_for_stream, &app, &last_emit)
                },
                err_fn,
                None,
            )
        }
        sample_format => {
            return Err(format!(
                "microphone sample format ยังไม่รองรับ: {sample_format}"
            ))
        }
    }
    .map_err(|error| format!("เริ่ม audio input stream ไม่สำเร็จ: {error}"))?;

    stream
        .play()
        .map_err(|error| format!("เปิด microphone stream ไม่สำเร็จ: {error}"))?;

    *recording_guard = Some(NativeRecording {
        wav_path,
        stream,
        writer,
    });

    register_recording_escape_shortcut(app);
    let _ = app.emit("dictation-state", "recording");
    let _ = show_indicator(app.clone(), "Recording".to_string());
    Ok(())
}

fn finish_native_recording(
    recording: NativeRecording,
    app: AppHandle,
    preferences: NativePreferences,
) {
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
                &app,
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

    unregister_recording_escape_shortcut(&app);
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

fn is_native_recording_active(app: &AppHandle) -> bool {
    let state = app.state::<NativeRecorderState>();
    state
        .recording
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

fn stop_native_recording(app: AppHandle) -> Result<(), String> {
    let Some(recording) = take_native_recording(&app)? else {
        return Ok(());
    };
    unregister_recording_escape_shortcut(&app);
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
    let Some(recording) = take_native_recording(&app)? else {
        return Ok(());
    };
    unregister_recording_escape_shortcut(&app);
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

    if is_recording {
        stop_native_recording(app)
    } else {
        start_native_recording(&app)
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(Size::Logical(LogicalSize::new(1040.0, 660.0)));
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn get_input_device_name() -> Result<String, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "ไม่พบ input microphone device".to_string())?;
    #[allow(deprecated)]
    device.name().map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_macos_privacy_pane(pane: String) -> Result<(), String> {
    let url = match pane.as_str() {
        "microphone" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        "accessibility" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        "keyboard" => "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
        _ => return Err("unknown privacy pane".to_string()),
    };

    Command::new("open")
        .arg(url)
        .status()
        .map_err(|error| format!("เปิด System Settings ไม่สำเร็จ: {error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "เปิด System Settings ไม่สำเร็จ".to_string())
}

#[tauri::command]
fn get_accessibility_permission_status() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        AXIsProcessTrusted()
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

fn setup_global_shortcut(app: &tauri::AppHandle) -> tauri::Result<()> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }

                if is_dictation_shortcut(app, shortcut) {
                    let _ = toggle_native_recording(app.clone());
                }
            })
            .build(),
    )?;

    app.global_shortcut()
        .register(DEFAULT_DICTATION_SHORTCUT)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()))?;

    Ok(())
}

fn register_recording_escape_shortcut(app: &tauri::AppHandle) {
    let app = app.clone();

    std::thread::spawn(move || {
        if !is_native_recording_active(&app) || app.global_shortcut().is_registered("escape") {
            return;
        }

        let _ = app
            .global_shortcut()
            .on_shortcut("escape", |app, _, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }

                let _ = cancel_native_recording(app.clone());
            });

        if !is_native_recording_active(&app) {
            let _ = app.global_shortcut().unregister("escape");
        }
    });
}

fn unregister_recording_escape_shortcut(app: &tauri::AppHandle) {
    let app = app.clone();

    std::thread::spawn(move || {
        if app.global_shortcut().is_registered("escape") {
            let _ = app.global_shortcut().unregister("escape");
        }
    });
}

fn emit_tray_action(app: &tauri::AppHandle, action: &str, should_show_window: bool) {
    if should_show_window {
        show_main_window(app);
    }
    let _ = app.emit("tray-action", action);
}

fn emit_section_action(app: &tauri::AppHandle, action: &str) {
    show_main_window(app);
    let _ = app.emit("settings-action", action);
}

fn apply_selected_input_device(app: &AppHandle, input_device_name: Option<String>) {
    if let Ok(preferences) = set_selected_input_device(app, input_device_name) {
        let _ = app.emit("preferences-updated", preferences.clone());
        let _ = app.emit(
            "input-devices-updated",
            collect_input_devices(preferences.input_device_name.as_deref()),
        );
    }

    let _ = refresh_tray_menu(app);
}

fn build_input_device_menu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let preferences = get_native_preferences(app).unwrap_or_default();
    let devices = collect_input_devices(preferences.input_device_name.as_deref());
    let input_menu = Submenu::with_id(app, "input-devices", "Microphone", true)?;
    let default_item = CheckMenuItem::with_id(
        app,
        "input:default",
        "Use system default",
        true,
        preferences.input_device_name.is_none(),
        None::<&str>,
    )?;
    input_menu.append(&default_item)?;

    if devices.is_empty() {
        let empty_item = MenuItem::with_id(
            app,
            "input:none",
            "No microphones found",
            false,
            None::<&str>,
        )?;
        input_menu.append(&empty_item)?;
        return Ok(input_menu);
    }

    let separator = PredefinedMenuItem::separator(app)?;
    input_menu.append(&separator)?;

    for (index, device) in devices.iter().enumerate() {
        let label = if device.is_default {
            format!("{} (Default)", device.name)
        } else {
            device.name.clone()
        };
        let item = CheckMenuItem::with_id(
            app,
            format!("input:{index}"),
            label,
            true,
            preferences.input_device_name.as_deref() == Some(device.name.as_str()),
            None::<&str>,
        )?;
        input_menu.append(&item)?;
    }

    Ok(input_menu)
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let toggle = MenuItem::with_id(app, "toggle", "Toggle Recording", true, Some("Alt+Space"))?;
    let input_menu = build_input_device_menu(app)?;
    let settings = MenuItem::with_id(app, "settings", "Open General", true, Some("Cmd+,"))?;
    let history = MenuItem::with_id(app, "history", "Open History", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Check whisper.cpp", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Open Main Window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("Cmd+Q"))?;
    let separator_one = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let separator_three = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &toggle,
            &separator_one,
            &input_menu,
            &separator_two,
            &history,
            &settings,
            &status,
            &separator_three,
            &show,
            &quit,
        ],
    )
}

fn refresh_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id("main") {
        let menu = build_tray_menu(app)?;
        tray.set_menu(Some(menu))?;
    }

    Ok(())
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = build_tray_menu(app.handle())?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("default app icon should exist");

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Murmur")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => {
                let _ = toggle_native_recording(app.clone());
            }
            "input:default" => apply_selected_input_device(app, None),
            id if id.starts_with("input:") => {
                if let Ok(index) = id.trim_start_matches("input:").parse::<usize>() {
                    let preferences = get_native_preferences(app).unwrap_or_default();
                    if let Some(device) =
                        collect_input_devices(preferences.input_device_name.as_deref()).get(index)
                    {
                        apply_selected_input_device(app, Some(device.name.clone()));
                    }
                }
            }
            "settings" => emit_section_action(app, "settings"),
            "history" => emit_section_action(app, "history"),
            "status" => emit_section_action(app, "status"),
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
            list_input_devices,
            list_available_models,
            list_model_catalog,
            download_model,
            uninstall_model,
            get_input_device_name,
            hide_indicator,
            hide_main_window,
            get_accessibility_permission_status,
            open_macos_privacy_pane,
            paste_clipboard,
            show_indicator,
            set_dictation_shortcut,
            set_native_preferences,
            toggle_native_recording,
            unregister_current_dictation_shortcut,
            restore_current_dictation_shortcut,
            cancel_native_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
