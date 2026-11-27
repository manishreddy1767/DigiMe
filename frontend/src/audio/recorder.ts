/** Records one voice sample from the microphone with the browser's MediaRecorder. */

export interface Recording {
  /** Stops and returns the recording. */
  stop(): Promise<Blob>;
  /** Stops and throws the recording away. */
  cancel(): void;
}

export type StartRecording = () => Promise<Recording>;

const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

export const startRecording: StartRecording = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Keep the voice natural: no echo cancellation or automatic gain, which colour the sound.
    audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
  });
  const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  const release = () => stream.getTracks().forEach((track) => track.stop());
  recorder.start();
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          release();
          resolve(new Blob(chunks, { type: recorder.mimeType.split(";")[0] || "audio/webm" }));
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = release;
      if (recorder.state !== "inactive") recorder.stop();
      else release();
    },
  };
};
