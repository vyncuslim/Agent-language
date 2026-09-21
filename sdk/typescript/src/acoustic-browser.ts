import { encodeVamlFrameToWav, AUDIBLE_4FSK_PROFILE, type AcousticProfile } from "./acoustic.js";
import {
  AcousticMicrophoneReceiver,
  type AcousticDecodedFrame,
  type AcousticMicrophoneReceiverOptions,
} from "./acoustic-live.js";

export interface BrowserMicrophoneOptions
  extends Omit<AcousticMicrophoneReceiverOptions, "inputSampleRate" | "onFrame"> {
  profile?: AcousticProfile;
  /** ScriptProcessor block size. Power-of-two values are required by WebAudio. */
  blockSize?: 256 | 512 | 1024 | 2048 | 4096 | 8192 | 16384;
  /** Browser audio constraints. DSP defaults to off because it can damage FSK tones. */
  constraints?: MediaTrackConstraints;
}

export interface BrowserMicrophoneHandle {
  readonly stream: MediaStream;
  readonly audioContext: AudioContext;
  readonly receiver: AcousticMicrophoneReceiver;
  stop(): Promise<void>;
}

/**
 * Start a real browser microphone receiver for VAML acoustic frames.
 *
 * The browser permission prompt remains authoritative. This helper never
 * bypasses microphone consent. Echo cancellation, noise suppression and AGC
 * default to false because speech-oriented DSP can distort modem tones.
 */
export async function startBrowserAcousticMicrophone(
  onFrame: (frame: AcousticDecodedFrame) => void,
  options: BrowserMicrophoneOptions = {},
): Promise<BrowserMicrophoneHandle> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Browser microphone API is unavailable");
  }
  if (typeof AudioContext === "undefined") {
    throw new Error("WebAudio AudioContext is unavailable");
  }

  const profile = options.profile ?? AUDIBLE_4FSK_PROFILE;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...options.constraints,
    },
    video: false,
  });

  let audioContext: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let sink: GainNode | undefined;
  try {
    audioContext = new AudioContext({ sampleRate: profile.sampleRate });
    if (audioContext.state === "suspended") await audioContext.resume();

    const receiver = new AcousticMicrophoneReceiver({
      ...options,
      profile,
      inputSampleRate: audioContext.sampleRate,
      onFrame,
    });
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(options.blockSize ?? 4096, 1, 1);
    sink = audioContext.createGain();
    sink.gain.value = 0;

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0);
      receiver.pushFloat32(input);
    };

    source.connect(processor);
    processor.connect(sink);
    // ScriptProcessor requires a connected graph to receive callbacks. The
    // zero-gain sink keeps captured microphone audio from feeding back.
    sink.connect(audioContext.destination);

    return {
      stream,
      audioContext,
      receiver,
      async stop() {
        processor!.onaudioprocess = null;
        try { source!.disconnect(); } catch {}
        try { processor!.disconnect(); } catch {}
        try { sink!.disconnect(); } catch {}
        for (const track of stream.getTracks()) track.stop();
        if (audioContext!.state !== "closed") await audioContext!.close();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    if (audioContext && audioContext.state !== "closed") await audioContext.close();
    throw error;
  }
}

export interface BrowserSpeakerOptions {
  profile?: AcousticProfile;
  audioContext?: AudioContext;
  leadingSilenceMs?: number;
  trailingSilenceMs?: number;
}

/** Play one already-encrypted VAML frame through the browser speaker. */
export async function playVamlFrameThroughBrowserSpeaker(
  frame: Uint8Array,
  options: BrowserSpeakerOptions = {},
): Promise<void> {
  if (typeof AudioContext === "undefined") throw new Error("WebAudio AudioContext is unavailable");
  const profile = options.profile ?? AUDIBLE_4FSK_PROFILE;
  const owned = !options.audioContext;
  const context = options.audioContext ?? new AudioContext({ sampleRate: profile.sampleRate });
  try {
    if (context.state === "suspended") await context.resume();
    const wav = encodeVamlFrameToWav(frame, {
      profile,
      leadingSilenceMs: options.leadingSilenceMs,
      trailingSilenceMs: options.trailingSilenceMs,
    });
    const bytes = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    const audio = await context.decodeAudioData(bytes);
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(context.destination);
    await new Promise<void>((resolve, reject) => {
      source.onended = () => resolve();
      try {
        source.start();
      } catch (error) {
        reject(error);
      }
    });
  } finally {
    if (owned && context.state !== "closed") await context.close();
  }
}
