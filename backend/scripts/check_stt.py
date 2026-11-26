import argparse
from pathlib import Path

from app.services.speech import WhisperService


def main() -> None:
    parser = argparse.ArgumentParser(description="Check faster-whisper on CPU.")
    parser.add_argument("audio", type=Path, help="Local WAV or supported audio file.")
    args = parser.parse_args()

    result = WhisperService().transcribe(args.audio)
    print("Runtime: faster-whisper base / CPU int8")
    print(f"Language: {result.language}")
    print(f"Elapsed: {result.elapsed_seconds:.2f}s")
    print(f"Transcript: {result.text or '(no speech recognized)'}")


if __name__ == "__main__":
    main()
