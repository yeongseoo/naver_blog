"use client";

import { useState } from "react";
import {
  generateDraftStub,
  type PostDraft,
  type WritingStyle,
  type GenerateOptions,
} from "@/lib/blocks";
import BlockPreview from "@/components/BlockPreview";

const STYLES: WritingStyle[] = ["정보성", "후기/리뷰", "일상", "제품추천"];
const IMAGE_OPTIONS: (number | "auto")[] = ["auto", 0, 1, 2, 3];

export default function Home() {
  const [keyword, setKeyword] = useState("");
  const [style, setStyle] = useState<WritingStyle>("정보성");
  const [imageCount, setImageCount] = useState<number | "auto">("auto");
  const [draft, setDraft] = useState<PostDraft | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleGenerate() {
    if (!keyword.trim()) return;
    const opts: GenerateOptions = { keyword, style, imageCount };
    // 지금은 로컬 스텁. Phase 7에서 /api/generate (Gemini) 호출로 교체.
    setDraft(generateDraftStub(opts));
    setCopied(false);
  }

  function handleCopy() {
    if (!draft) return;
    navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">블로그 자동 작성</h1>
        <p className="mt-1 text-sm text-gray-500">
          주제(키워드)만 입력하면 글 구조가 생성됩니다. (현재: 미리보기 · AI는 곧 연결)
        </p>
      </header>

      {/* 입력 폼 */}
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <label className="mb-1 block text-sm font-semibold text-gray-700">주제 / 키워드</label>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
          placeholder="예: 아이폰17 케이스 추천"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-green-500"
        />

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">스타일</label>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value as WritingStyle)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-green-500"
            >
              {STYLES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">이미지 개수</label>
            <select
              value={String(imageCount)}
              onChange={(e) =>
                setImageCount(e.target.value === "auto" ? "auto" : Number(e.target.value))
              }
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-green-500"
            >
              {IMAGE_OPTIONS.map((o) => (
                <option key={String(o)} value={String(o)}>
                  {o === "auto" ? "자동" : `${o}개`}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={handleGenerate}
          disabled={!keyword.trim()}
          className="mt-5 w-full rounded-lg bg-green-600 py-2.5 text-sm font-bold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          글 생성
        </button>
      </section>

      {/* 결과 */}
      {draft && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-gray-900">미리보기</h2>
            <div className="flex gap-2">
              <button
                onClick={() => setShowJson((v) => !v)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
              >
                {showJson ? "미리보기" : "JSON 보기"}
              </button>
              <button
                onClick={handleCopy}
                className="rounded-md bg-gray-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-900"
              >
                {copied ? "복사됨 ✓" : "JSON 복사"}
              </button>
            </div>
          </div>

          {showJson ? (
            <pre className="max-h-[500px] overflow-auto rounded-xl border border-gray-200 bg-gray-900 p-4 text-xs text-green-300">
              {JSON.stringify(draft, null, 2)}
            </pre>
          ) : (
            <BlockPreview draft={draft} />
          )}

          <p className="text-xs text-gray-400">
            지금은 생성된 JSON을 복사해 Extension의 &quot;Block Engine JSON&quot;에 붙여
            발행할 수 있습니다. (자동 발행 연결은 다음 단계)
          </p>
        </section>
      )}
    </main>
  );
}
