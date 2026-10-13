"use client";
import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Image from "next/image";
export const MarkdownContent = memo(function MarkdownContent({ children }: { children: string }) {
  return <div className="markdown-content"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    // Spans keep the media valid inside the paragraph Markdown wraps around images.
    img: ({ src, alt, title }) => typeof src === "string" && /^\/api\/attachments\/[0-9a-f-]{36}$/.test(src)
      ? <span className="markdown-media">
        {title === "video" ? <video src={src} controls playsInline preload="metadata" aria-label={alt || "Vídeo gerado"} />
          : <a href={src} target="_blank" rel="noopener noreferrer"><Image src={src} alt={alt || "Imagem gerada"} width={1024} height={1024} unoptimized /></a>}
        <a className="markdown-media-open" href={src} target="_blank" rel="noopener noreferrer" aria-label={`Abrir ${title === "video" ? "vídeo" : "imagem"} em nova aba`}>Abrir em nova aba</a>
      </span>
      : <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer">{alt || "Abrir imagem"}</a>,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  }}>{children}</Markdown></div>;
});
