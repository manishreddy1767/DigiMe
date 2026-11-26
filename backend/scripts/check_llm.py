from app.services.ollama import CONTEXT_SIZE, MODEL, OllamaService


def main() -> None:
    result = OllamaService().generate_check_response()
    print(f"Model: {MODEL}")
    print(f"Context: {CONTEXT_SIZE}")
    print(f"Elapsed: {result.elapsed_seconds:.2f}s")
    if result.tokens_per_second is not None:
        print(f"Generation: {result.tokens_per_second:.2f} tokens/s")
    print(f"Response: {result.text}")


if __name__ == "__main__":
    main()
