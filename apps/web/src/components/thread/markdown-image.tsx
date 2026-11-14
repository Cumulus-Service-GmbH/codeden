import { ImageOff } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { defaultComponents, type ExtraProps } from "streamdown";
import { isMockMode, serverOrigin } from "@/lib/api";
import { imageSource, remoteImageUrl } from "@/lib/markdown-images";

const DefaultImage = defaultComponents.img;

/** Remote images the user loaded on this page: they stay loaded while a reply re-renders. */
const loadedUrls = new Set<string>();

type ImageProps = ComponentProps<"img"> & ExtraProps;

/**
 * An image in Markdown (#317). Local ones (inline, stored artifacts) render as usual; a remote
 * one renders a placeholder naming its host until the user clicks **Load image**, so an agent
 * reply or a stranger's issue can't make the browser contact a host by being shown. A loaded
 * image comes through CodeDen's server, the only place the UI's CSP lets images come from.
 */
export function MarkdownImage({ srcSet: _srcSet, sizes: _sizes, ...props }: ImageProps) {
  const source = imageSource(props.src, [window.location.origin, serverOrigin]);
  const remoteUrl = source.kind === "remote" ? source.url : null;
  const [load, setLoad] = useState(() => remoteUrl !== null && loadedUrls.has(remoteUrl));

  if (source.kind === "local") return <DefaultImage {...props} />;
  if (source.kind === "remote" && load) {
    const src = isMockMode ? source.url : remoteImageUrl(serverOrigin, source.url);
    return <DefaultImage {...props} src={src} />;
  }
  const alt = props.alt?.trim();
  return (
    <span
      data-streamdown="image-blocked"
      title={source.kind === "remote" ? source.url : undefined}
      className="my-1 inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1 align-middle text-[12.5px] text-muted-foreground"
    >
      <ImageOff className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        {alt ? `${alt} · ` : ""}
        {source.kind === "remote" ? (
          <>
            Image from <span className="font-medium text-foreground">{source.host}</span>
          </>
        ) : (
          "Image not shown"
        )}
      </span>
      {source.kind === "remote" && (
        <button
          type="button"
          aria-label={`Load image from ${source.host}`}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            loadedUrls.add(source.url);
            setLoad(true);
          }}
        >
          Load image
        </button>
      )}
    </span>
  );
}

/** `<picture><source srcset>` would pick a remote file over the `<img>`: sources are dropped. */
export function MarkdownSource() {
  return null;
}
