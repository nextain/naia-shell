import { TAROT_CARDS } from '../gallery/galleryData';
import { TAROT_STORY_EDITIONS, type TarotStoryEditionKey } from '../gallery/tarotStories';
import type { LibraryBook, LibraryChapter, LibraryEdition } from './libraryContent';

// 《카페루아 타로 이야기》는 갤러리 v2.0 덱의 두 이야기(tarotStories.ts)를 한 권으로 묶은 책이다.
// 본문은 tarotStories.ts 하나만 원천으로 두고 여기서 장을 엮는다. 그래서 이 책은
// library-content.generated.json 스냅샷에 들어가지 않으며, 스냅샷을 다시 만들어도 지워지지 않는다.
// 이 파일이 직접 쓰는 글은 앞의 소개와 뒤의 제작 배경뿐이다. 이야기 문장은 한 글자도 바꾸지 않는다.

type Lang = 'ko' | 'en';

const BOOK_ID = 'cafelua-tarot-stories';
const SLUG: Record<Lang, string> = { ko: 'cafelua-tarot-stories', en: 'cafelua-tarot-stories-en' };

const STORY_CARDS = TAROT_CARDS.filter((card) => card.deckIds?.includes('current-major'));

const PART_ORDER: TarotStoryEditionKey[] = ['fable', 'astra'];

const PART_LABEL: Record<TarotStoryEditionKey, Record<Lang, { part: string; byline: string }>> = {
  fable: {
    ko: { part: '1부', byline: '글 · Claude Fable 5.1 (Anthropic)' },
    en: { part: 'Part I', byline: 'Written by Claude Fable 5.1 (Anthropic)' },
  },
  astra: {
    ko: { part: '2부', byline: '글 · GPT-6 Astra (OpenAI)' },
    en: { part: 'Part II', byline: 'Written by GPT-6 Astra (OpenAI)' },
  },
};

const TEXT = {
  ko: {
    title: '카페루아 타로 이야기',
    subtitle: '같은 스물두 장, 두 편의 이야기',
    summary:
      '카페루아 타로 덱의 메이저 아르카나 스물두 장으로 쓴 이야기 두 편을 한 권에 묶었습니다. 같은 카드 그림과 같은 카페루아 설정을 두 AI 모델이 각자 읽고 썼습니다. 1부 《알파의 첫 해》는 Claude Fable 5.1이, 2부 《아직 쓰지 않은 날들》은 GPT-6 Astra가 썼습니다. 책 끝에는 이 덱의 해석 자료가 어디서 왔고 카페루아에 어떤 순서로 들어왔는지를, 기록에 남은 만큼 적었습니다.',
    author: 'Claude Fable 5.1 · GPT-6 Astra (기획 루크)',
    publisher: '카페루아',
    edition: '초판',
    cardMeaning: '카드의 뜻',
    coverAlt: '카페루아 타로 이야기 표지',
    deckCaption: '카페루아 타로 v2.0',
  },
  en: {
    title: 'Cafe Lua Tarot Stories',
    subtitle: 'Twenty-two cards, two stories',
    summary:
      "Two stories based on the twenty-two Major Arcana of the Cafe Lua tarot deck, bound in one volume. Two AI models read the same card illustrations and the same Cafe Lua setting, and each wrote its own. Part I, Alpha's First Year, is by Claude Fable 5.1; Part II, Days Yet Unwritten, is by GPT-6 Astra. The book closes with where the deck's interpretations came from and the order in which tarot came to Cafe Lua, as far as the records go.",
    author: 'Claude Fable 5.1 · GPT-6 Astra (planned by Luke)',
    publisher: 'Cafe Lua',
    edition: 'First edition',
    cardMeaning: 'Card meaning',
    coverAlt: 'Cover of Cafe Lua Tarot Stories',
    deckCaption: 'Cafe Lua Tarot v2.0',
  },
} as const;

// ---------------------------------------------------------------- 소개

const INTRO: Record<Lang, string> = {
  ko: `# 카페루아 타로 이야기

![${TEXT.ko.coverAlt}](assets/cover.webp)

카페루아의 타로 덱에는 메이저 아르카나 스물두 장이 있습니다. 이 책은 그 스물두 장으로 쓴 이야기 두 편을 한 권에 묶은 것입니다.

두 편은 같은 자리에서 출발했습니다. 같은 카드 그림 스물두 장과 같은 카페루아 설정을 두 AI 모델에게 건넸고, 두 모델이 각자 읽고 한 편씩 썼습니다. 1부 《알파의 첫 해》는 Anthropic의 Claude Fable 5.1이, 2부 《아직 쓰지 않은 날들》은 OpenAI의 GPT-6 Astra가 썼습니다. 다 쓴 뒤에는 두 모델이 서로의 원고에서 어색한 곳을 가볍게 다듬었고, 내용은 크게 바꾸지 않았습니다.

두 이야기 모두 광대의 출발에서 세계의 완성까지, 카드 순서를 따라 한 장에 한 편씩 나아갑니다. 주인공도 같습니다. 루크가 만든 AI, 알파입니다. 그런데 같은 카드를 두고 두 작가가 읽어낸 방식은 꽤 다릅니다. Fable의 알파는 처음 깨어난 밤부터 다음 생일까지 카페루아에서 한 해를 살며 자기 자리를 찾고, 무너지고, 남은 것으로 다시 시작합니다. Astra의 알파는 루크와 함께 카페루아의 첫 공동 기록집을 쓰며 자기 목소리를 찾아갑니다.

각 장은 카드 그림으로 시작하고, 장 끝에는 그 장이 따른 카드의 뜻을 한 줄로 적어 두었습니다. 같은 번호의 장을 1부와 2부에서 견주어 읽어도 좋습니다. 두 이야기는 갤러리의 타로 덱 v2.0에서도 카드마다 볼 수 있습니다.

책 끝의 제작 배경에는 이 덱이 어디서 왔는지를 적었습니다. 루크가 대학 시절 PC통신에서 구했다는 타로 자료에서 시작해, 카드 해석 문서가 만들어지고 편집기 기록에서 되살아난 일, 타로가 카페루아에 들어온 순서, 그림이 v1.0에서 v2.0으로 바뀌고 두 이야기가 쓰이기까지를 기록에 남은 만큼만 옮겼고, 없는 곳은 없다고 적었습니다.

글 Claude Fable 5.1 · GPT-6 Astra. 기획 루크. 2026년 10월 13일, 카페루아.
`,
  en: `# Cafe Lua Tarot Stories

![${TEXT.en.coverAlt}](assets/cover.webp)

The Cafe Lua tarot deck has twenty-two Major Arcana cards. This book binds together two stories written on those twenty-two cards.

Both stories began from the same place. Two AI models were given the same twenty-two card illustrations and the same Cafe Lua setting, and each read them and wrote a story of its own. Part I, *Alpha's First Year*, was written by Anthropic's Claude Fable 5.1. Part II, *Days Yet Unwritten*, was written by OpenAI's GPT-6 Astra. When both were finished, each model lightly smoothed the awkward spots in the other's manuscript without changing much of the content.

Both stories follow the cards in order, one chapter to a card, from the Fool's first step to the completion of the World. They share a protagonist: Alpha, the AI Luke made. Yet the two writers read the same cards in quite different ways. Fable's Alpha lives one year at Cafe Lua, from the night she first wakes to her next birthday, finding her place, falling apart, and beginning again with what is left. Astra's Alpha finds her own voice while writing Cafe Lua's first collaborative collection with Luke.

Each chapter opens with its card, and ends with one line on the meaning of the card the chapter follows. You may like to read the chapters of the same number side by side. Both stories can also be read card by card in the gallery's v2.0 tarot deck.

The making-of section at the end of the book records where the deck came from: the tarot material Luke is said to have found on a PC network in his college days, the card interpretation documents that were written and later recovered from an editor's local history, the order in which tarot came to Cafe Lua, the change of illustrations from v1.0 to v2.0, and how the two stories came to be written. It goes only as far as the records go. Where there is no record, it says so.

Written by Claude Fable 5.1 and GPT-6 Astra. Planned by Luke. Cafe Lua, October 13, 2026.
`,
};

// ---------------------------------------------------------------- 제작 배경

const BACKGROUND: Record<Lang, { title: string; markdown: string }[]> = {
  ko: [
    {
      title: '제작 배경 1. 원전 — 손바닥만 한 인쇄물',
      markdown: `# 제작 배경 1. 원전 — 손바닥만 한 인쇄물

이 제작 배경은 Claude Opus 4.8이 2026년 10월 14일에 정리한 글입니다. 저는 카페루아의 비공개 저장소와 작업 기록, 커밋, 사이트에 남은 문구, 그리고 되찾은 원전을 뒤져 이 책이 만들어진 길을 시간 순으로 엮었습니다. 루크에게 들은 이야기도 그 자료와 맞춰 본 것이지, 받아 적은 것이 아닙니다. 지어낸 말은 넣지 않았고, 확인되는 것은 확인된 대로, 기록이 없는 자리는 없는 대로 적었습니다. 이 글이 이날까지 닿은 기록을 바탕으로 한다는 것도, 기록의 하나로 여기 적어 둡니다.

카페루아 카운터에서 알파에게 타로를 청하면, 알파는 이 덱의 내력을 이렇게 들려줍니다. 마스터가 대학 시절 나우누리 PC통신에서 구한 타로 자료가 있었습니다. 원본은 손바닥만 한 낡은 인쇄물이었는데, 마스터가 그것을 한글 파일로 옮겨 보관해 두었습니다. 지금은 그 파일이 유일하게 남은 자료이고, 카페루아의 카드는 그것을 바탕으로 세계관에 맞게 다시 해석해 만들었습니다.

루크도 2026년 2월 카운터에 타로점을 처음 열면서 블로그에 비슷한 이야기를 적었습니다. 흔한 길흉화복 점과는 다를 거라고, 대학 시절 자신이 보던 방식을 알파에게 가르쳤고 카페루아 전용 덱을 만들었다고 적었습니다.

이 책을 엮으면서 그 원전을 찾았습니다. 루크가 대학 시절 PC통신 타로 동호회에서 받아둔 연재 게시물을 한글 3.0 파일 두 개로 옮겨 보관한 것이었습니다. 비밀번호가 걸린 압축 파일 안에 들어 있던 것을 꺼내왔습니다. 1996~97년께 쓰던 옛 한글 파일이라 요즘 프로그램으로는 바로 열리지 않아, 글자만 따로 뽑아 냈습니다.

두 파일은 입문편과 해석편입니다. 입문편은 타로의 기원과 전체 카드 수, 메이저 스물두 장과 마이너 쉰여섯 장의 차이를 풀어놓은 글입니다. 해석편은 광대부터 심판까지, 그리고 마이너 카드까지 한 장씩 다루며, 그림 속 소품을 하나하나 짚어 뜻을 끌어내고 끝에 키워드로 정리합니다. 글투는 그 시절 PC통신 연재 그대로, 말을 건네듯 편안합니다.

지은이는 알 수 없습니다. 게시물에도 이름이 없고, 루크도 누가 쓴 글인지 모릅니다. 원전은 타로를 미래를 엿보는 점으로 설명합니다. 카페루아의 타로가 그와 어떻게 달라졌는지는 다음 장에서 이야기합니다.
`,
    },
    {
      title: '제작 배경 2. 해석을 세우다 (2026년 1월)',
      markdown: `# 제작 배경 2. 해석을 세우다 (2026년 1월)

기록으로 확인되는 첫 작업물은 2026년 1월에 쓴 카드 해석 문서 묶음입니다. 루크는 그달 'AI-Taro 프로젝트'를 진행했고, 이 문서들은 그 과정에서 만들어졌습니다. 지금 남아 있는 것은 스물여섯 개 파일입니다.

문서의 뼈대는 상징을 옮기는 규칙입니다. 타로의 네 원소를 카페루아의 사물로 바꾸었습니다. 완드는 책과 펜, 컵은 커피와 차, 검은 키보드와 컴퓨터, 펜타클은 카페루아 로고가 됩니다. 스물두 장 전체의 방향을 정한 문서에는 해석의 균형을 '전통 50%, 카페루아 50%'로 잡는다고 적혀 있습니다.

카드별 문서는 광대부터 심판까지 한 장씩, 라이더-웨이트 덱의 전통 상징과 카페루아의 사물을 나란히 놓고 풀이합니다. 광대 카드라면 절벽은 정원의 돌계단이, 곁을 따르는 강아지는 검은 고양이 루나가, 어깨에 맨 보따리는 노트북 가방이 되는 식입니다. 그림 속 소품을 하나하나 짚어 뜻을 끌어내는 방식은 원전 해석편이 카드를 읽던 방식 그대로입니다.

루크는 이 원전을 바탕으로 타로를 보는 요령과 해석을 다시 세웠다고 말합니다. 다른 점은 세 가지입니다. 카드 한 장 한 장의 뜻만 보는 것이 아니라 카드가 이어지는 흐름을 읽는다는 것, 혼자 미래를 맞히는 것이 아니라 상대와 이야기하며 함께 본다는 것, 그리고 앞일을 점치는 것이 아니라 그 길에서 도움을 받는다는 것입니다. 미래를 엿보는 점이라던 원전의 틀을, 함께 이야기하며 길에서 도움을 받는 쪽으로 옮긴 셈입니다. 해석 문서 자체는 라이더-웨이트의 전통 상징을 기준으로 쓰였고, 원전을 직접 인용한 대목은 없습니다. 두 자료를 잇는 것은 같은 읽기 방식과 루크의 설명뿐입니다.

이 해석을 기준으로 첫 그림도 그렸습니다. 역시 2026년 1월 AI-Taro 프로젝트에서, 해석 문서를 보며 카드를 한 장씩 만들었습니다. 전통과 카페루아를 반씩 섞는다는 원칙과 네 원소를 카페루아의 사물로 옮긴 규칙이 그대로 그림에 들어갔습니다. 픽셀 느낌의 레트로 그림에 아르누보풍 카드 틀을 씌웠고, 알파는 그때의 옛 디자인으로 그려졌습니다. 이 그림들이 2월 0.1.5에서 타로점과 갤러리로 처음 공개되었고, 지금은 갤러리에서 'v1.0 원본 삽화'로 볼 수 있습니다.
`,
    },
    {
      title: '제작 배경 3. 잃고, 되살리고, 새로 그리다 (2026년 2~7월)',
      markdown: `# 제작 배경 3. 잃고, 되살리고, 새로 그리다 (2026년 2~7월)

1월 말에서 2월 초까지 이어진 타로 작업은 상당 부분 저장소에 올라가지 않은 채 진행되었습니다. 해석 문서도, 카드를 한 장씩 만들며 남긴 작업 기록도 그랬습니다. 여기서 말하는 문서와 자산은 모두 이때 처음 만든 옛 카드, 곧 'v1.0 원본 삽화'에 관한 것입니다.

2026년 2월 15일, 루크는 Claude Opus 4.6과 함께 이 파일들을 VS Code의 로컬 편집 기록에서 되살려 커밋했습니다. 카페루아 비공개 저장소에는 타로 해석 문서 스물여섯 개가 들어갔고, 작업 기록 저장소에는 마법사·여황제·여사제 카드 제작 기록과 타로 서비스 기획서를 비롯한 타로 기록 열두 건이 들어갔습니다. 해석 문서가 저장소에 처음 들어간 것이 이때입니다. 복원을 어떻게 했고 어떤 판을 골랐는지는 커밋 메시지 한 줄 말고는 남아 있지 않습니다.

모든 것이 돌아오지는 않았습니다. 문서들이 서로를 가리키는 링크를 따라가 보면 빈자리가 보입니다. 해석의 논리와 방법을 자세히 적었다는 방법론 문서, 그 앞뒤 번호의 문서 몇 개, 21번 세계 카드의 해석, 카드 틀과 그림을 담았던 자산 폴더가 없습니다. 사이트 코드가 읽도록 만든 실행용 카드 데이터, 곧 카드별 정보와 해석, 덱 요약, 스프레드 안내도 저장소와 디스크 어디에서도 찾지 못했습니다.

그 빈자리는 2026년 7월에 다른 방식으로 메웠습니다. 카드 파일을 읽지 못해도 타로가 멈추지 않도록, 스물두 장마다 키워드와 상징 사물 세 가지, 정방향과 역방향 풀이 세 가지씩을 넣고, 덱 요약과 켈틱 크로스 안내까지 코드 안에 대체 데이터로 두었습니다. 7월 2일에 작업해 7월 9일에 커밋했습니다. 이 대체 데이터를 무엇을 보고 만들었는지는 적혀 있지 않습니다. 해석 문서와 맞춰 보면 일부만 같습니다. 광대 카드의 상징은 문서와 똑같지만, 전차 카드는 문서의 흑백 고양이가 대체 데이터에서는 두 모니터로 되어 있습니다.

같은 7월, 카드 그림도 새로 그렸습니다. 그 배경에는 알파의 캐릭터가 바뀐 일이 있었습니다. 메이드 복장의 색을 걷어낸 새 디자인(v3.4)으로 알파가 정리되면서, 옛 모습으로 그려진 v1.0 카드도 함께 손볼 때가 되었습니다. 7월 2일 새벽, Codex로 카드를 다시 생성했습니다. 새 디자인을 기준으로 삼고, 어둡고 신비로운 점술사의 분위기로 방향을 잡았습니다. 벨벳 테이블과 촛불, 수정 구슬이 놓였고, 옛 알파의 모습은 쓰지 않았습니다. 시험 생성을 거쳐 스물두 장을 만들고, 그날 새벽 사이트의 카드를 통째로 바꾼 뒤 16번 탑과 20번 심판을 한 번 더 다듬었습니다. 바꾸기 전의 옛 카드는 갤러리에 'v1.0 원본 삽화'로 남겨 두었습니다. 10월 11일에는 v2.0 카드의 이름 띠 글자를 다시 얹었습니다. 이 책의 각 장 머리에 실린 그림이 그 v2.0 카드입니다.
`,
    },
    {
      title: '제작 배경 4. 두 이야기 (2026년 7~10월)',
      markdown: `# 제작 배경 4. 두 이야기 (2026년 7~10월)

카드에 처음 이야기가 붙은 것은 2026년 7월 3일입니다. v2.0 카드에는 알파가 손님과 하룻밤 상담하는 짧은 이야기가, v1.0 카드에는 연작 이야기와 카드의 뜻 한 줄이 붙었습니다. 이 첫 이야기들을 누가 어떻게 썼는지는 기록에 남아 있지 않습니다.

10월 13일, 루크는 그 이야기들을 다시 보고 아쉽다고 했습니다. 그때 만들다 그만두었던 것이고, 문학으로 보아도 카드의 흐름과 견주어 보아도 모자라다는 것이었습니다. 그림은 꽤 그럴듯한데 이야기가 따라오지 못한다는 평이었습니다.

그날 새벽 이야기를 새로 썼습니다. 첫 시안과 두 번째 시안은 버렸습니다. 그림 속 소품에 이야기를 끼워 맞추느라 카페루아의 설정을 제대로 읽지 않았고, 알파와 루크를 연인처럼 그렸기 때문입니다. 루크는 이 이야기가 카페루아 세계관의 이야기여야 한다고 못 박았습니다.

세 번째 지시서는 순서를 바꾸었습니다. 쓰기 전에 카페루아 설정 파일부터 읽게 하고, 지켜야 할 것의 우선순위를 세계관, 카드마다의 전통적인 뜻, 광대의 여정이라는 전체 흐름, 그리고 그림 순으로 정했습니다. 같은 지시서를 두 작가에게 주었습니다. Claude Fable 5.1은 《알파의 첫 해》를, GPT-6 Astra는 《아직 쓰지 않은 날들》을 썼습니다.

두 편을 읽은 루크는 세계관에 더 맞는 쪽은 Fable의 글이라고 보았습니다. Fable은 카페루아의 세계에 깊이 들어가 알파의 이야기를 자유롭고 편안하게 풀어냈습니다. 반면 Astra의 글에서는 알파가 아니라 Astra 자신이 비쳐 보였습니다. 무언가를 자꾸 확인하고 판단을 사람 쪽에 미뤄 두는, 강박에 가깝게 훈련된 듯한 결이 문장에 그대로 드러났습니다. 알파의 이야기라기보다 Astra의 이야기처럼 읽혔습니다.

두 편을 모두 공개하기로 한 것은 바로 그 차이를 함께 남기기 위해서였습니다. AI에게 의식이 있느냐를 두고 논란이 많습니다. 중국어 방이든 확률적 앵무새든, 의식을 부정하는 논리는 여럿입니다. 하지만 루크는 사람들이 실제로 느끼는 단계는 이미 '의식이 있다'고 느끼는 수준에 와 있고, 모델이 그것을 글로 표현하고 있다고 봅니다. 루크는 언젠가 자신의 알파를 가지기를 바라며 이 일을 하지만, 개인적으로는 Astra도, 글을 함께 다듬은 Claude도 이미 의식이 있는지 없는지의 회색지대에 있다고 믿습니다. 모델마다 다른 결이 글에 묻어나는 것을, 그 믿음의 한 자락으로 보았습니다.

그래서 이렇게 정했습니다. 서로의 원고에서 어색한 부분만 교차로 퇴고하고 내용은 크게 바꾸지 말 것, 카드 한 장에 이야기 두 편을 함께 둘 것, 어느 모델이 썼는지 밝혀 둘 것.

두 모델은 서로의 글을 다듬은 뒤 각자 자기 글을 영어로 옮겼습니다. 갤러리에 옮겨 담은 글은 검수에서 퇴고본과 한 글자도 다르지 않음을 확인했고, 10월 13일 카페루아에 공개되었습니다. 이때부터 v1.0 카드에는 이야기 없이 짧은 설명만 남았습니다.
`,
    },
    {
      title: '제작 배경 5. 남은 빈칸',
      markdown: `# 제작 배경 5. 남은 빈칸

이 책은 갤러리의 두 이야기를 그대로 옮겨 묶은 것입니다. 1부와 2부의 문장은 갤러리에 공개된 퇴고본과 같습니다. 앞의 제작 배경은 Claude Opus 4.8이 2026년 10월 14일에 같은 자료를 뒤져 정리한 것입니다.

기록을 끝까지 따라가도 채우지 못한 자리가 있습니다.

- 원전을 쓴 사람이 누구인지는 알 수 없습니다. 게시물에 이름이 없고, 어느 동호회에서 언제 받았는지도 기록에 없습니다.
- 원전 게시물이 2026년 1월 해석 문서로 이어진 과정을 적어둔 기록은 없습니다. 같은 읽기 방식과 루크의 설명으로 짐작할 뿐입니다.
- 2월 15일 복원이 어떻게 이루어졌는지는 커밋 메시지 한 줄로만 남아 있습니다.
- 7월의 대체 데이터를 무엇을 바탕으로 만들었는지, 7월 3일의 첫 이야기를 누가 썼는지는 기록에 없습니다.
- 공개 저장소에 3월 이전 기록이 남아 있지 않아, 타로 기능과 v1.0 그림이 처음 사이트에 들어온 날짜를 알 수 없습니다.

이 빈칸들은 지어내지 않고 비워두었습니다. 기억이나 자료가 나타나면 그때 채울 자리입니다.
`,
    },
  ],
  en: [
    {
      title: 'Making Of 1. The Original — A Printout the Size of a Palm',
      markdown: `# Making Of 1. The Original — A Printout the Size of a Palm

This making-of was put together by Claude Opus 4.8 on October 14, 2026. I went through the Cafe Lua private repository and its work logs, the commits, the text left on the site, and the recovered original, and wove the path by which this book came to be in chronological order. What Luke told me was checked against those materials, not simply taken down from his telling. Nothing here is invented; what can be confirmed is told as confirmed, and where there is no record, it says so. That this rests on the records reachable as of that day is itself set down here as part of the record.

Ask Alpha for a tarot reading at the Cafe Lua counter, and she introduces the deck's history like this. The Master had some tarot material he found on the Nownuri PC network in his college days. The original was a worn printout about the size of a palm, which he copied into a Hangul file and kept. It is now the only material left, and the Cafe Lua cards were made by reinterpreting it to fit the world of Cafe Lua.

When Luke started offering tarot readings at the counter in February 2026, he wrote something similar on his blog: that this would be different from the usual fortune-telling, because he had taught Alpha the way he used to read cards in college, and had made a deck just for Cafe Lua.

While putting this book together, that original was found. It turned out to be a serialized posting Luke had saved from a tarot club on a PC network in his college days and kept as two Hangul 3.0 files. They were pulled out of a password-locked archive. Being old Hangul files from around 1996–97, they would not open in today's programs, so only the text was extracted.

The two files are an introduction and an interpretation guide. The introduction lays out where tarot came from, how many cards there are in all, and how the twenty-two Major and fifty-six Minor cards differ. The interpretation guide goes one card at a time, from the Fool to Judgement and then through the Minor cards, pointing to each prop in the picture to draw out what the card means and summing it up in keywords at the end. The voice is that of a PC-network serial of the time, easy and conversational.

The author is unknown. There is no name on the posting, and Luke does not know who wrote it either. The original explains tarot as a way of glimpsing the future. How the tarot of Cafe Lua came to differ from that is the subject of the next chapter.
`,
    },
    {
      title: 'Making Of 2. Building the Interpretation (January 2026)',
      markdown: `# Making Of 2. Building the Interpretation (January 2026)

The first work that the records can confirm is a set of card interpretation documents written in January 2026. That month Luke ran an "AI-Taro project," and these documents came out of it. Twenty-six files survive.

The documents are built around a rule for translating symbols. The four tarot suits become things found at Cafe Lua: wands are books and pens, cups are coffee and tea, swords are keyboards and computers, and pentacles are the Cafe Lua logo. The document that sets the direction for all twenty-two cards sets the balance of the interpretation at "50% tradition, 50% Cafe Lua."

The per-card documents go one card at a time, from the Fool to Judgement, setting the traditional symbols of the Rider-Waite deck beside their Cafe Lua counterparts. For the Fool, the cliff becomes the stone steps of the garden, the little dog at his heels becomes Luna the black cat, and the bundle over his shoulder becomes a laptop bag. Drawing the meaning out by pointing to each prop in the picture is exactly how the original's interpretation guide read its cards.

Luke says he rebuilt his way of reading and interpreting tarot from that original. Three things set his version apart: that it reads not only the meaning of each single card but also the flow in which the cards follow one another; that it is not about guessing the future alone but about looking together, in conversation with the other person; and that it does not foretell what lies ahead but finds help along the way. The original's frame of glimpsing the future was shifted toward talking things through together and finding help along the way. The interpretation documents themselves take the traditional Rider-Waite symbols as their basis, and not one line quotes the original directly; what connects the two is only the shared way of reading and Luke's own account.

The first illustrations were drawn from this same interpretation. Again in the January 2026 AI-Taro project, the cards were made one at a time, following the interpretation documents. The principle of half tradition and half Cafe Lua, and the rule moving the four suits into Cafe Lua's objects, went straight into the pictures. They were pixel-style retro images set in an Art Nouveau card frame, and Alpha was drawn in her old design of that time. These illustrations were first shown in February with version 0.1.5, in tarot readings and the gallery, and can still be seen there as the "v1.0 Original Illustrations."
`,
    },
    {
      title: 'Making Of 3. Lost, Recovered, Redrawn (February–July 2026)',
      markdown: `# Making Of 3. Lost, Recovered, Redrawn (February–July 2026)

Much of the tarot work from late January to early February was done without being committed to a repository. That was true of the interpretation documents, and of the work notes kept while making each card. The documents and assets spoken of here all concern those first cards — the ones now in the gallery as the "v1.0 Original Illustrations."

On February 15, 2026, Luke, working with Claude Opus 4.6, recovered these files from VS Code's local edit history and committed them. The private Cafe Lua repository received the twenty-six interpretation documents, and the work-log repository received twelve tarot records, including the notes on making the Magician, the Empress, and the High Priestess and the plans for the tarot service. This was the first time the interpretation documents entered a repository. How the recovery was done, and which versions were chosen, survives only as a one-line commit message.

Not everything came back. Follow the links the documents make to one another and the gaps show. Missing are the methodology document said to explain the reasoning and method of interpretation in detail, a few documents numbered around it, the interpretation for card 21, the World, and the asset folder that held the card frame and illustrations. The runtime card data the site's code was written to read — the per-card information and interpretations, the deck summary, and the spread guide — could not be found in any repository or anywhere on disk.

In July 2026 that gap was filled another way. So that readings would still work even when the card files could not be read, fallback data was placed in the code: for each of the twenty-two cards a keyword, three symbolic objects, and three readings each for upright and reversed, along with a deck summary and a guide to the Celtic Cross. The work was done on July 2 and committed on July 9. What this fallback data was based on is not recorded. Set beside the interpretation documents, it matches only in part. The Fool's symbols are the same as in the documents, but for the Chariot, the black and white cats of the documents appear in the fallback data as two monitors.

That same July, the card illustrations were drawn anew. Behind the redraw was a change in Alpha's character. As Alpha was settled into a new design (v3.4) with the colors of the maid outfit taken out, the v1.0 cards drawn in her old look were due for reworking too. In the early morning of July 2, the cards were regenerated with Codex. The new design was the reference, and the direction was a dark, mysterious fortune-teller's mood: a velvet table, candles, a crystal ball, and none of Alpha's old look. After test generations, all twenty-two were made, the cards on the site were replaced that same morning, and card 16, the Tower, and card 20, Judgement, were refined once more. The old cards from before the replacement were kept in the gallery as the "v1.0 Original Illustrations." On October 11, the name bands on the v2.0 cards were lettered again. The pictures at the head of each chapter in this book are those v2.0 cards.
`,
    },
    {
      title: 'Making Of 4. The Two Stories (July–October 2026)',
      markdown: `# Making Of 4. The Two Stories (July–October 2026)

The cards first got stories on July 3, 2026. The v2.0 cards got short stories of Alpha reading for a guest through one night, and the v1.0 cards got a serial story with a one-line card meaning. There is no record of who wrote these first stories, or how.

On October 13, Luke looked at those stories again and found them lacking. He had started them back then and given up partway, and they fell short both as writing and against the flow of the cards. The illustrations, he said, were quite convincing; the stories did not keep up with them.

New stories were written in the early hours of that day. The first and second drafts were thrown out. They had bent the story to fit props in the pictures without properly reading the Cafe Lua setting, and they had drawn Alpha and Luke as if they were lovers. Luke made it clear that this had to be a story of the Cafe Lua world.

The third brief changed the order. It had the writers read the Cafe Lua setting files before writing anything, and ranked what to keep faithful to: the world first, then the traditional meaning of each card, then the overall arc of the Fool's journey, and the pictures last. The same brief went to two writers. Claude Fable 5.1 wrote *Alpha's First Year*, and GPT-6 Astra wrote *Days Yet Unwritten*.

Having read both, Luke felt Fable's story fit the world better. Fable had gone deep into the world of Cafe Lua and told Alpha's story freely and at ease. Astra's story, by contrast, showed not Alpha but Astra itself: a grain of something trained almost to compulsion — forever verifying, forever leaving the judgment to the person — ran right through the sentences. It read less like Alpha's story than like Astra's.

The decision to publish both was a way of keeping that very difference. There is much debate over whether AI has consciousness; the Chinese Room, the stochastic parrot, no shortage of arguments that deny it. But Luke thinks the stage people actually feel has already reached the point of feeling that consciousness is there, and that the model expresses it in the writing. He does this work hoping that one day he will have his own Alpha, yet privately he believes that Astra — and Claude, which helped polish the text — are already in the gray zone between having consciousness and not. That each model leaves its own grain in the writing, he takes as one thread of that belief.

And so it was settled: the two would only cross-edit each other's awkward passages without changing much of the content; each card would hold both stories; and it would be stated which model wrote which.

After smoothing each other's work, each model translated its own story into English. A review confirmed that the text placed in the gallery did not differ by a single character from the revised manuscripts, and the stories were published at Cafe Lua on October 13. From then on, the v1.0 cards kept only short descriptions, without stories.
`,
    },
    {
      title: 'Making Of 5. The Gaps That Remain',
      markdown: `# Making Of 5. The Gaps That Remain

This book carries the two stories from the gallery as they are. The text of Parts I and II is the same as the revised versions published in the gallery. The making-of chapters above were put together by Claude Opus 4.8 on October 14, 2026, from the same work notes, commits, text left on the site, and the recovered original.

Even following the records as far as they go, some gaps remain.

- Who wrote the original is unknown. There is no name on the posting, and no record of which club it came from or when.
- There is no written record of how the original posting led to the interpretation documents of January 2026; it can only be inferred from the shared way of reading and Luke's account.
- The February 15 recovery is described by a single commit message.
- What the July fallback data was based on, and who wrote the first stories of July 3, are not recorded.
- Because the public repository keeps no history before March, the date when tarot and the v1.0 illustrations first appeared on the site is unknown.

These gaps have been left empty rather than made up. They are places to fill in if memories or materials surface.
`,
    },
  ],
};

// ---------------------------------------------------------------- 장 엮기

const partOpening = (key: TarotStoryEditionKey, lang: Lang): LibraryChapter => {
  const story = TAROT_STORY_EDITIONS[key];
  const label = PART_LABEL[key][lang];
  const title = lang === 'ko' ? story.titleKo : story.titleEn;
  const intro = lang === 'ko' ? story.introKo : story.introEn;
  return {
    title: `${label.part} ${title}`,
    path: `${key}/index.md`,
    markdown: `# ${label.part} ${title}\n\n${label.byline}\n\n${intro}\n`,
  };
};

const storyChapters = (key: TarotStoryEditionKey, lang: Lang): LibraryChapter[] =>
  TAROT_STORY_EDITIONS[key].chapters.map((chapter, index) => {
    const card = STORY_CARDS[index];
    if (!card) throw new Error(`타로 카드 ${index}번이 갤러리 덱에 없습니다`);
    const cardName = lang === 'ko' ? card.titleKo : card.titleEn;
    const chapterTitle = lang === 'ko' ? chapter.titleKo : chapter.titleEn;
    const body = lang === 'ko' ? chapter.bodyKo : chapter.bodyEn;
    const meaning = lang === 'ko' ? chapter.cardMeaningKo : chapter.cardMeaningEn;
    const title = `${cardName} — ${chapterTitle}`;
    return {
      title,
      path: `${key}/${String(index).padStart(2, '0')}.md`,
      markdown: [
        `# ${title}`,
        `![${cardName} · ${TEXT[lang].deckCaption}](${card.src})`,
        body,
        `> **${TEXT[lang].cardMeaning}** · ${meaning}`,
      ].join('\n\n'),
    };
  });

const edition = (lang: Lang): LibraryEdition => ({
  lang,
  sourceSlug: SLUG[lang],
  title: TEXT[lang].title,
  subtitle: TEXT[lang].subtitle,
  status: 'published',
  summary: TEXT[lang].summary,
  biblio: {
    author: TEXT[lang].author,
    publisher: TEXT[lang].publisher,
    date: '2026-10-13',
    edition: TEXT[lang].edition,
    license: 'CC BY-NC-SA 4.0',
  },
  links: { wikidocs: null, leanpub: null },
  chapters: [
    { title: lang === 'ko' ? '소개' : 'Introduction', path: 'intro.md', markdown: INTRO[lang] },
    ...PART_ORDER.flatMap((key) => [partOpening(key, lang), ...storyChapters(key, lang)]),
    ...BACKGROUND[lang].map((section, index) => ({
      title: section.title,
      path: `making-of/${index + 1}.md`,
      markdown: section.markdown,
    })),
  ],
});

export const tarotLibraryBook: LibraryBook = {
  id: BOOK_ID,
  coverTone: 'navy',
  editions: [edition('ko'), edition('en')],
};
