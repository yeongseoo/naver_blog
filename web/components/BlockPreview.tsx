import type { Block, PostDraft } from "@/lib/blocks";

/** 블록 하나를 네이버 글처럼 미리보기 렌더링 */
function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "heading":
      return <h2 className="text-xl font-bold text-gray-900 mt-5 mb-2">{block.content}</h2>;
    case "text":
      return <p className="text-[15px] leading-8 text-gray-800 my-2">{block.content}</p>;
    case "quote":
      return (
        <blockquote className="border-l-4 border-gray-400 pl-4 py-1 my-3 text-gray-600 italic">
          {block.content}
        </blockquote>
      );
    case "divider":
      return <hr className="my-5 border-gray-300" />;
    case "image":
      return (
        <div className="my-3 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-blue-300 bg-blue-50 py-10 text-center">
          {block.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={block.url} alt={block.alt ?? ""} className="max-h-64 rounded" />
          ) : (
            <>
              <span className="text-sm font-semibold text-blue-500">🖼 이미지 위치</span>
              <span className="mt-1 px-4 text-xs text-blue-400">
                {block.prompt ?? "이미지"}
              </span>
            </>
          )}
        </div>
      );
    default:
      return null;
  }
}

/** 글 전체 미리보기 */
export default function BlockPreview({ draft }: { draft: PostDraft }) {
  return (
    <article className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h1 className="mb-4 border-b border-gray-100 pb-3 text-2xl font-bold text-gray-900">
        {draft.title}
      </h1>
      {draft.blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </article>
  );
}
