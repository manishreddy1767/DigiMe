from pathlib import Path

from app.services.speech import KokoroService


def main() -> None:
    output_dir = Path("artifacts/feasibility")
    service = KokoroService()
    print("Runtime: Kokoro on CPU")
    print(f"Model load: {service.load_seconds:.2f}s")

    for filename, text in (
        ("kokoro-check.wav", "This is a local CPU speech processing check."),
        ("kokoro-warm-check.wav", "This second sentence checks warm synthesis speed."),
    ):
        output_path = output_dir / filename
        elapsed, audio_seconds = service.synthesize_to_file(output_path, text)
        real_time_factor = elapsed / audio_seconds if audio_seconds else 0
        print(
            f"Synthesis: {elapsed:.2f}s for {audio_seconds:.2f}s audio "
            f"(RTF {real_time_factor:.2f})"
        )
        print(f"Audio: {output_path.resolve()}")


if __name__ == "__main__":
    main()
