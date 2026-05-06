import { Router, Request, Response } from 'express';
import { execSync, spawn } from 'child_process';
import { writeFile, mkdir, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TMP_BASE = path.join(__dirname, '../../tmp');

function findFfmpeg(): string {
  // 1. Explicit override — used by the Pinokio launcher (start.js passes
  //    FFMPEG_PATH pointing at the ffmpeg binary it downloaded into the
  //    launcher's own folder layout). Highest priority because Pinokio's
  //    cwd doesn't sit at the same depth as portable run.bat.
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  // 2. Portable layout (run.bat path): <projectRoot>/ffmpeg/ffmpeg.exe.
  //    install.bat downloads ffmpeg here on first install.
  const portableExe = path.resolve(__dirname, '../../../../ffmpeg/ffmpeg.exe');
  if (existsSync(portableExe)) return portableExe;
  // Same layout but Linux/Mac (no .exe).
  const portableBin = path.resolve(__dirname, '../../../../ffmpeg/ffmpeg');
  if (existsSync(portableBin)) return portableBin;

  // 3. System PATH — for users who installed ffmpeg via brew/apt/scoop.
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    // The single supported fix: re-run the installer / Update step. Both
    // run.bat (portable) and the Pinokio launcher's install.js + update.js
    // download ffmpeg.exe into <projectRoot>/ffmpeg/ which is what case (2)
    // looks for. We deliberately do NOT auto-download from the running
    // server — the network step belongs in the install/update flow where
    // the user can see progress and retry on failure.
    throw new Error('ffmpeg not found — re-run install/update');
  }
}

function hasNvenc(ffmpegPath: string): boolean {
  try {
    const result = execSync(`"${ffmpegPath}" -encoders 2>&1`, { encoding: 'utf-8', timeout: 5000 });
    return result.includes('h264_nvenc');
  } catch {
    return false;
  }
}

// Active render sessions
const sessions = new Map<string, { dir: string; frameCount: number; created: number }>();

// Cleanup old sessions (>30min)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.created > 30 * 60 * 1000) {
      rm(session.dir, { recursive: true, force: true }).catch(() => {});
      sessions.delete(id);
    }
  }
}, 60000);

// 1. Start render session
router.post('/start', async (_req: Request, res: Response) => {
  const sessionId = `render_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(TMP_BASE, sessionId);
  await mkdir(dir, { recursive: true });
  sessions.set(sessionId, { dir, frameCount: 0, created: Date.now() });
  console.log(`[Render] Session started: ${sessionId}`);
  res.json({ sessionId });
});

// 2. Upload frame chunk (batches of ~50-100 frames)
router.post('/frames', async (req: Request, res: Response) => {
  const { sessionId, frames, startIndex } = req.body;
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(400).json({ error: 'Invalid session' });
    return;
  }

  const start = startIndex || session.frameCount;
  for (let i = 0; i < frames.length; i++) {
    const frameData = Buffer.from(frames[i], 'base64');
    await writeFile(path.join(session.dir, `frame${String(start + i).padStart(6, '0')}.jpg`), frameData);
  }
  session.frameCount = start + frames.length;

  res.json({ received: frames.length, total: session.frameCount });
});

// 3. Finish — encode with ffmpeg
router.post('/finish', async (req: Request, res: Response) => {
  const { sessionId, audioUrl, fps = 30 } = req.body;
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(400).json({ error: 'Invalid session' });
    return;
  }

  try {
    const ffmpegPath = findFfmpeg();
    const useNvenc = hasNvenc(ffmpegPath);
    console.log(`[Render] Encoding ${session.frameCount} frames, nvenc: ${useNvenc}`);

    // Copy audio
    const audioPath = path.join(session.dir, 'audio.mp3');
    if (audioUrl?.startsWith('/')) {
      const localAudioPath = path.join(__dirname, '../../public', audioUrl);
      if (existsSync(localAudioPath)) {
        const audioData = await readFile(localAudioPath);
        await writeFile(audioPath, audioData);
      }
    }

    const outputPath = path.join(session.dir, 'output.mp4');
    const args = [
      '-framerate', String(fps),
      '-i', path.join(session.dir, 'frame%06d.jpg'),
    ];

    if (existsSync(audioPath)) args.push('-i', audioPath);

    if (useNvenc) {
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '28');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
    }

    args.push(
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      '-y', outputPath,
    );

    console.log(`[Render] ffmpeg ${args.slice(0, 10).join(' ')}...`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { stdio: 'pipe' });
      let stderr = '';
      proc.stderr?.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      });
      proc.on('error', reject);
    });

    const videoData = await readFile(outputPath);
    console.log(`[Render] Done: ${(videoData.length / 1024 / 1024).toFixed(1)}MB`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
    res.send(videoData);

  } catch (error: any) {
    console.error('[Render] Failed:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    rm(session.dir, { recursive: true, force: true }).catch(() => {});
    sessions.delete(sessionId);
  }
});

export default router;
