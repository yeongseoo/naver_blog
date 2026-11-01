// 블로그 글의 Block 데이터 구조 (Extension이 소비하는 형식과 동일)
// Phase 7에서 Gemini가 생성할 JSON도 이 타입을 따른다.

export type Block =
  | { type: "heading"; content: string }
  | { type: "text"; content: string }
  | { type: "quote"; content: string }
  | { type: "divider"; style?: "default" | "line1" | "line2" }
  // 이미지: AI 이미지가 준비되기 전에는 prompt(생성 요청)만, 준비되면 url/path 채움
  | { type: "image"; prompt?: string; url?: string; path?: string; alt?: string };

export interface PostDraft {
  title: string;
  blocks: Block[];
}

export type WritingStyle = "정보성" | "후기/리뷰" | "일상" | "제품추천";

export interface GenerateOptions {
  keyword: string;
  style: WritingStyle;
  imageCount: number | "auto";
}

/**
 * 로컬 스텁 생성기 (AI 없이 초안 구조 생성).
 * Phase 7에서 Gemini 호출로 교체한다. 시그니처/반환 타입은 유지한다.
 */
export function generateDraftStub(opts: GenerateOptions): PostDraft {
  const kw = opts.keyword.trim() || "주제";
  const imgN = opts.imageCount === "auto" ? 2 : opts.imageCount;

  const styleIntro: Record<WritingStyle, string> = {
    정보성: `이번 글에서는 ${kw}에 대해 꼭 알아야 할 핵심 정보를 정리했습니다.`,
    "후기/리뷰": `${kw}를 직접 사용해보고 느낀 점을 솔직하게 정리해봤습니다.`,
    일상: `요즘 ${kw} 때문에 이런저런 생각이 많았는데, 오늘은 그 이야기를 해볼게요.`,
    제품추천: `${kw}를 고민 중이라면, 아래 내용을 참고하면 선택에 도움이 될 거예요.`,
  };

  const blocks: Block[] = [];
  blocks.push({ type: "heading", content: `${kw} 완벽 정리` });
  blocks.push({ type: "text", content: styleIntro[opts.style] });

  if (imgN >= 1) {
    blocks.push({ type: "image", prompt: `${kw}의 대표 이미지, 자연스러운 사진` });
  }

  blocks.push({ type: "heading", content: `${kw}의 핵심 포인트` });
  blocks.push({
    type: "text",
    content: `${kw}에서 가장 중요한 부분은 다음과 같습니다. 실제로 살펴보면 생각보다 챙겨야 할 점이 많습니다.`,
  });

  if (imgN >= 2) {
    blocks.push({ type: "image", prompt: `${kw}의 세부 모습을 보여주는 이미지` });
  }

  blocks.push({
    type: "text",
    content: `또한 ${kw}를 선택할 때는 목적과 상황을 먼저 고려하는 것이 좋습니다.`,
  });

  blocks.push({ type: "quote", content: `${kw}, 제대로 알고 선택하면 후회가 없습니다.` });
  blocks.push({ type: "divider", style: "line1" });
  blocks.push({
    type: "text",
    content: `여기까지 ${kw}에 대해 정리해봤습니다. 도움이 되셨다면 좋겠습니다.`,
  });

  return { title: `${kw} 완벽 정리`, blocks };
}
