import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ children, href }) => (
    <a href={href} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  ),
  img: ({ alt }) => <span>{alt}</span>,
};

function MessageContent({ content, role }: { content: string; role: "user" | "assistant" }) {
  if (role === "user") {
    return <p>{content}</p>;
  }
  return (
    <div className="message-markdown">
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default MessageContent;
