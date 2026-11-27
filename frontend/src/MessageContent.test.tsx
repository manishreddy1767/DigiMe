import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MessageContent from "./MessageContent";

afterEach(cleanup);

describe("message content", () => {
  it("renders assistant Markdown without raw HTML or remote images", () => {
    const { container } = render(
      <MessageContent
        content={
          "The answer is **391**.\n\n- first\n- second\n\n" +
          "[Docs](https://example.test) <b>raw</b> ![tracker](https://example.test/p.png)"
        }
        role="assistant"
      />,
    );

    expect(screen.getByText("391").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("tracker")).toBeTruthy();
  });

  it("keeps user messages as plain text", () => {
    render(<MessageContent content="Use **stars** literally" role="user" />);

    expect(screen.getByText("Use **stars** literally").tagName).toBe("P");
  });
});
