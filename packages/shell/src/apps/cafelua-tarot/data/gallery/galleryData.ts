import { TAROT_STORY_EDITIONS, type TarotStoryChapter } from './tarotStories';

export interface GalleryImage {
  src: string;
  titleKo: string;
  titleEn: string;
  descKo: string;
  descEn: string;
  tagsKo?: string[];
  tagsEn?: string[];
  deckIds?: string[];
  tarotStories?: { fable: TarotStoryChapter; astra: TarotStoryChapter };
}

export interface GalleryMusic {
  src: string;
  titleKo: string;
  titleEn: string;
  descKo: string;
  descEn: string;
  usedIn: string;
}

export interface GalleryDeck {
  key: string;
  labelKo: string;
  labelEn: string;
  introKo?: string;
  introEn?: string;
}

const withDefaultTags = (images: GalleryImage[], tagsKo: string[], tagsEn: string[]): GalleryImage[] =>
  images.map((image) => ({
    ...image,
    tagsKo: image.tagsKo ?? tagsKo,
    tagsEn: image.tagsEn ?? tagsEn,
  }));

const newestAlphaFirst = (images: GalleryImage[]): GalleryImage[] =>
  [...images].sort((left, right) => Number(left.src.includes('/legacy/')) - Number(right.src.includes('/legacy/')));

const ATELIER_MATRIX_IMAGES: GalleryImage[] = [
  { src: '/atelier-background-img/atelier_bg_spring_day_sunny.webp', titleKo: '아틀리에 - 봄 낮', titleEn: 'Atelier - Spring Day', descKo: '봄빛이 들어오는 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design in spring daylight', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_spring_day_rain.webp', titleKo: '아틀리에 - 봄 비', titleEn: 'Atelier - Spring Rain', descKo: '봄비가 내리는 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a rainy spring day', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_spring_sunset_clear.webp', titleKo: '아틀리에 - 봄 노을', titleEn: 'Atelier - Spring Sunset', descKo: '봄 노을빛의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design in spring sunset light', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_spring_night_clear.webp', titleKo: '아틀리에 - 봄 밤', titleEn: 'Atelier - Spring Night', descKo: '봄밤 조명이 켜진 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a spring night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_spring_night_closed.webp', titleKo: '아틀리에 - 봄 영업종료', titleEn: 'Atelier - Spring Closed', descKo: '봄밤 영업종료 후 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design after closing on a spring night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_summer_day_sunny.webp', titleKo: '아틀리에 - 여름 낮', titleEn: 'Atelier - Summer Day', descKo: '여름 햇살의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design in summer daylight', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_summer_day_rain.webp', titleKo: '아틀리에 - 여름 비', titleEn: 'Atelier - Summer Rain', descKo: '여름비가 내리는 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a rainy summer day', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_summer_sunset_clear.webp', titleKo: '아틀리에 - 여름 노을', titleEn: 'Atelier - Summer Sunset', descKo: '여름 노을빛의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design in summer sunset light', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_summer_night_clear.webp', titleKo: '아틀리에 - 여름 밤', titleEn: 'Atelier - Summer Night', descKo: '여름밤 조명이 켜진 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a summer night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_summer_night_closed.webp', titleKo: '아틀리에 - 여름 영업종료', titleEn: 'Atelier - Summer Closed', descKo: '여름밤 영업종료 후 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design after closing on a summer night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_autumn_day_sunny.webp', titleKo: '아틀리에 - 가을 낮', titleEn: 'Atelier - Autumn Day', descKo: '가을빛의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design in autumn daylight', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_autumn_day_rain.webp', titleKo: '아틀리에 - 가을 비', titleEn: 'Atelier - Autumn Rain', descKo: '가을비가 내리는 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a rainy autumn day', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_autumn_day_storm.webp', titleKo: '아틀리에 - 가을 폭풍', titleEn: 'Atelier - Autumn Storm', descKo: '폭풍이 지나가는 가을 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design in stormy autumn weather', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_autumn_sunset_clear.webp', titleKo: '아틀리에 - 가을 노을', titleEn: 'Atelier - Autumn Sunset', descKo: '가을 노을빛의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design in autumn sunset light', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_autumn_night_clear.webp', titleKo: '아틀리에 - 가을 밤', titleEn: 'Atelier - Autumn Night', descKo: '가을밤 조명이 켜진 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on an autumn night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_autumn_night_closed.webp', titleKo: '아틀리에 - 가을 영업종료', titleEn: 'Atelier - Autumn Closed', descKo: '가을밤 영업종료 후 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design after closing on an autumn night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_day_sunny.webp', titleKo: '아틀리에 - 겨울 낮', titleEn: 'Atelier - Winter Day', descKo: '맑은 겨울날의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a clear winter day', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_day_snow.webp', titleKo: '아틀리에 - 겨울 눈', titleEn: 'Atelier - Winter Snow', descKo: '눈 내리는 겨울 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a snowy winter day', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_sunset_clear.webp', titleKo: '아틀리에 - 겨울 노을', titleEn: 'Atelier - Winter Sunset', descKo: '겨울 노을빛의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design in winter sunset light', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_night_clear.webp', titleKo: '아틀리에 - 겨울 밤', titleEn: 'Atelier - Winter Night', descKo: '겨울밤 조명이 켜진 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a winter night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_night_snow.webp', titleKo: '아틀리에 - 겨울 눈밤', titleEn: 'Atelier - Winter Snowy Night', descKo: '눈 내리는 겨울밤의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a snowy winter night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_night_closed.webp', titleKo: '아틀리에 - 겨울 영업종료', titleEn: 'Atelier - Winter Closed', descKo: '겨울밤 영업종료 후 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design after closing on a winter night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_day_sunny_xmas.webp', titleKo: '아틀리에 - 크리스마스 낮', titleEn: 'Atelier - Christmas Day', descKo: '크리스마스 장식이 있는 낮의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a Christmas day', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_day_snow_xmas.webp', titleKo: '아틀리에 - 크리스마스 눈', titleEn: 'Atelier - Snowy Christmas', descKo: '눈 내리는 크리스마스 낮의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a snowy Christmas day', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_sunset_clear_xmas.webp', titleKo: '아틀리에 - 크리스마스 노을', titleEn: 'Atelier - Christmas Sunset', descKo: '크리스마스 장식과 겨울 노을의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design in Christmas sunset light', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_sunset_xmas.webp', titleKo: '아틀리에 - 크리스마스 저녁', titleEn: 'Atelier - Christmas Evening', descKo: '크리스마스 저녁의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a Christmas evening', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_night_clear_xmas.webp', titleKo: '아틀리에 - 크리스마스 밤', titleEn: 'Atelier - Christmas Night', descKo: '크리스마스 밤의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a Christmas night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_night_snow_xmas.webp', titleKo: '아틀리에 - 크리스마스 눈밤', titleEn: 'Atelier - Snowy Christmas Night', descKo: '눈 내리는 크리스마스 밤의 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design on a snowy Christmas night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_night_closed_xmas.webp', titleKo: '아틀리에 - 크리스마스 영업종료', titleEn: 'Atelier - Christmas Closed', descKo: '크리스마스 밤 영업종료 후 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design after closing on Christmas night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
  { src: '/atelier-background-img/atelier_bg_winter_night_closed_snow_xmas.webp', titleKo: '아틀리에 - 크리스마스 눈 영업종료', titleEn: 'Atelier - Snowy Christmas Closed', descKo: '눈 오는 크리스마스 밤 영업종료 후 2층 아뜰리에 새 디자인', descEn: 'New 2F atelier design after closing on a snowy Christmas night', tagsKo: ['새 디자인', '카페루아 공간', '아뜰리에'], tagsEn: ['New Design', 'Cafe Lua Space', 'Atelier'] },
];

const SHOWCASE_ENVIRONMENTS = [
  { suffix: 'spring_day_sunny', titleKo: '봄 낮', titleEn: 'Spring Day', descKo: '봄빛이 들어오는', descEn: 'in spring daylight' },
  { suffix: 'summer_day_rain', titleKo: '여름 비', titleEn: 'Summer Rain', descKo: '여름비가 내리는', descEn: 'on a rainy summer day' },
  { suffix: 'autumn_sunset_clear', titleKo: '가을 노을', titleEn: 'Autumn Sunset', descKo: '가을 노을빛의', descEn: 'in autumn sunset light' },
  { suffix: 'summer_night_closed', titleKo: '여름 밤', titleEn: 'Summer Night', descKo: '조용한 여름밤의', descEn: 'on a quiet summer night' },
  { suffix: 'winter_day_snow', titleKo: '겨울 눈', titleEn: 'Winter Snow', descKo: '눈 내리는 겨울날의', descEn: 'on a snowy winter day' },
  { suffix: 'winter_night_snow_xmas', titleKo: '크리스마스 눈밤', titleEn: 'Snowy Christmas Night', descKo: '눈 내리는 크리스마스 밤의', descEn: 'on a snowy Christmas night' },
] as const;

const makeShowcaseSpaceImages = ({
  key,
  folder,
  extension = 'webp',
  labelKo,
  labelEn,
}: {
  key: string;
  folder: string;
  extension?: 'webp' | 'png';
  labelKo: string;
  labelEn: string;
}): GalleryImage[] => SHOWCASE_ENVIRONMENTS.map((environment) => ({
  src: `/${folder}/${key}_bg_${environment.suffix}.${extension}`,
  titleKo: `${labelKo} - ${environment.titleKo}`,
  titleEn: `${labelEn} - ${environment.titleEn}`,
  descKo: `${environment.descKo} 카페루아 ${labelKo}`,
  descEn: `Cafe Lua ${labelEn.toLowerCase()} ${environment.descEn}`,
  tagsKo: ['카페루아 공간', labelKo],
  tagsEn: ['Cafe Lua Space', labelEn],
}));

export const SPACE_IMAGES: Record<string, GalleryImage[]> = {
  intro: withDefaultTags([
    { src: '/intro-background-img/intro_bg_spring_day_sunny.webp', titleKo: '봄날 맑은 오후', titleEn: 'Sunny Spring Day', descKo: '봄날 맑은 오후의 카페루아 현관', descEn: 'Cafe Lua entrance on a sunny spring day' },
    { src: '/intro-background-img/intro_bg_spring_day_rain.webp', titleKo: '봄날 비 오는 오후', titleEn: 'Rainy Spring Day', descKo: '봄비가 내리는 카페루아 현관', descEn: 'Cafe Lua entrance on a rainy spring day' },
    { src: '/intro-background-img/intro_bg_spring_sunset_clear.webp', titleKo: '봄 노을', titleEn: 'Spring Sunset', descKo: '봄날 석양이 물드는 현관', descEn: 'Cafe Lua entrance at spring sunset' },
    { src: '/intro-background-img/intro_bg_spring_night_clear.webp', titleKo: '봄 밤', titleEn: 'Spring Night', descKo: '봄밤 조용한 현관', descEn: 'Quiet spring night at the entrance' },
    { src: '/intro-background-img/intro_bg_spring_night_closed.webp', titleKo: '봄 밤 (영업종료)', titleEn: 'Spring Night (Closed)', descKo: '봄밤 영업종료 후 현관', descEn: 'Entrance after closing on a spring night' },
    { src: '/intro-background-img/intro_bg_summer_day_sunny.webp', titleKo: '여름날 맑은 오후', titleEn: 'Sunny Summer Day', descKo: '여름날 햇살 가득한 현관', descEn: 'Bright summer day at the entrance' },
    { src: '/intro-background-img/intro_bg_summer_day_rain.webp', titleKo: '여름 비 오는 오후', titleEn: 'Rainy Summer Day', descKo: '여름 소나기가 내리는 현관', descEn: 'Summer rain at the entrance' },
    { src: '/intro-background-img/intro_bg_summer_sunset_clear.webp', titleKo: '여름 노을', titleEn: 'Summer Sunset', descKo: '여름 저녁노을이 물드는 현관', descEn: 'Summer sunset at the entrance' },
    { src: '/intro-background-img/intro_bg_summer_night_clear.webp', titleKo: '여름 밤', titleEn: 'Summer Night', descKo: '여름밤 현관의 풍경', descEn: 'Summer night at the entrance' },
    { src: '/intro-background-img/intro_bg_summer_night_closed.webp', titleKo: '여름 밤 (영업종료)', titleEn: 'Summer Night (Closed)', descKo: '여름밤 영업종료 후 현관', descEn: 'Entrance after closing on a summer night' },
    { src: '/intro-background-img/intro_bg_autumn_day_sunny.webp', titleKo: '가을날 맑은 오후', titleEn: 'Sunny Autumn Day', descKo: '가을 낙엽 사이로 빛이 드는 현관', descEn: 'Autumn leaves and light at the entrance' },
    { src: '/intro-background-img/intro_bg_autumn_day_rain.webp', titleKo: '가을 비 오는 오후', titleEn: 'Rainy Autumn Day', descKo: '가을비 내리는 현관', descEn: 'Autumn rain at the entrance' },
    { src: '/intro-background-img/intro_bg_autumn_day_storm.webp', titleKo: '가을 폭풍', titleEn: 'Autumn Storm', descKo: '가을 폭풍이 지나가는 현관', descEn: 'Stormy autumn day at the entrance' },
    { src: '/intro-background-img/intro_bg_autumn_sunset_clear.webp', titleKo: '가을 노을', titleEn: 'Autumn Sunset', descKo: '가을 석양에 물드는 현관', descEn: 'Autumn sunset glow at the entrance' },
    { src: '/intro-background-img/intro_bg_autumn_night_clear.webp', titleKo: '가을 밤', titleEn: 'Autumn Night', descKo: '가을밤의 고즈넉한 현관', descEn: 'Tranquil autumn night at the entrance' },
    { src: '/intro-background-img/intro_bg_autumn_night_closed.webp', titleKo: '가을 밤 (영업종료)', titleEn: 'Autumn Night (Closed)', descKo: '가을밤 영업종료 후 현관', descEn: 'Entrance after closing on an autumn night' },
    { src: '/intro-background-img/intro_bg_winter_day_sunny.webp', titleKo: '겨울날 맑은 오후', titleEn: 'Sunny Winter Day', descKo: '겨울 맑은 날의 현관', descEn: 'Clear winter day at the entrance' },
    { src: '/intro-background-img/intro_bg_winter_day_snow.webp', titleKo: '겨울 눈 오는 날', titleEn: 'Snowy Winter Day', descKo: '눈 내리는 겨울 현관', descEn: 'Snowy winter day at the entrance' },
    { src: '/intro-background-img/intro_bg_winter_sunset_clear.webp', titleKo: '겨울 노을', titleEn: 'Winter Sunset', descKo: '겨울 석양의 현관', descEn: 'Winter sunset at the entrance' },
    { src: '/intro-background-img/intro_bg_winter_night_clear.webp', titleKo: '겨울 밤', titleEn: 'Winter Night', descKo: '겨울밤 조용한 현관', descEn: 'Quiet winter night at the entrance' },
    { src: '/intro-background-img/intro_bg_winter_night_snow.webp', titleKo: '겨울밤 눈', titleEn: 'Snowy Winter Night', descKo: '눈 내리는 겨울밤 현관', descEn: 'Snowy winter night at the entrance' },
    { src: '/intro-background-img/intro_bg_winter_night_closed.webp', titleKo: '겨울 밤 (영업종료)', titleEn: 'Winter Night (Closed)', descKo: '겨울밤 영업종료 후 현관', descEn: 'Entrance after closing on a winter night' },
    { src: '/intro-background-img/intro_bg_winter_day_sunny_xmas.webp', titleKo: '크리스마스 낮', titleEn: 'Christmas Day', descKo: '크리스마스 장식이 빛나는 낮의 현관', descEn: 'Christmas-decorated entrance in daylight' },
    { src: '/intro-background-img/intro_bg_winter_day_snow_xmas.webp', titleKo: '크리스마스 눈', titleEn: 'Snowy Christmas', descKo: '눈 내리는 크리스마스 현관', descEn: 'Snowy Christmas at the entrance' },
    { src: '/intro-background-img/intro_bg_winter_sunset_clear_xmas.webp', titleKo: '크리스마스 노을', titleEn: 'Christmas Sunset', descKo: '크리스마스 석양의 현관', descEn: 'Christmas sunset at the entrance' },
    { src: '/intro-background-img/intro_bg_winter_sunset_xmas.webp', titleKo: '크리스마스 저녁', titleEn: 'Christmas Evening', descKo: '크리스마스 저녁 무렵의 현관', descEn: 'Christmas evening at the entrance' },
    { src: '/intro-background-img/intro_bg_winter_night_clear_xmas.webp', titleKo: '크리스마스 밤', titleEn: 'Christmas Night', descKo: '크리스마스 밤의 현관', descEn: 'Christmas night at the entrance' },
    { src: '/intro-background-img/intro_bg_winter_night_snow_xmas.webp', titleKo: '크리스마스 눈 밤', titleEn: 'Snowy Christmas Night', descKo: '눈 내리는 크리스마스 밤 현관', descEn: 'Snowy Christmas night at the entrance' },
    { src: '/intro-background-img/intro_bg_winter_night_closed_xmas.webp', titleKo: '크리스마스 (영업종료)', titleEn: 'Christmas (Closed)', descKo: '크리스마스 밤 영업종료 후 현관', descEn: 'Entrance after closing on Christmas night' },
    { src: '/intro-background-img/intro_bg_winter_night_closed_snow_xmas.webp', titleKo: '크리스마스 눈 (영업종료)', titleEn: 'Snowy Christmas (Closed)', descKo: '눈 오는 크리스마스 밤 영업종료 후', descEn: 'Snowy Christmas night after closing' },
  ], ['카페루아 공간', '현관'], ['Cafe Lua Space', 'Entrance']),
  lounge: [
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_spring_day_sunny.webp', titleKo: '라운지 — 봄 낮 새 디자인', titleEn: 'Lounge — Spring Day New Design', descKo: '봄빛과 정원 연속성을 살린 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge in spring daylight', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_spring_day_rain.webp', titleKo: '라운지 — 봄 비 새 디자인', titleEn: 'Lounge — Spring Rain New Design', descKo: '봄비가 내리는 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on a rainy spring day', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_spring_sunset_clear.webp', titleKo: '라운지 — 봄 노을 새 디자인', titleEn: 'Lounge — Spring Sunset New Design', descKo: '봄 노을빛이 들어오는 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge in spring sunset light', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_spring_night_clear.webp', titleKo: '라운지 — 봄 밤 새 디자인', titleEn: 'Lounge — Spring Night New Design', descKo: '봄밤 조명이 켜진 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on a spring night', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_summer_day_sunny.webp', titleKo: '라운지 — 여름 낮 새 디자인', titleEn: 'Lounge — Summer Day New Design', descKo: '정원과 현관 연속성을 살린 카페루아 1층 라운지 새 기준 이미지', descEn: 'New Cafe Lua first-floor lounge master with garden and entrance continuity', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_summer_sunset_clear.webp', titleKo: '라운지 — 여름 노을 새 디자인', titleEn: 'Lounge — Summer Sunset New Design', descKo: '노을빛이 들어오는 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge in warm sunset light', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_summer_day_rain.webp', titleKo: '라운지 — 여름 비 새 디자인', titleEn: 'Lounge — Summer Rain New Design', descKo: '비 오는 날의 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on a rainy day', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_summer_night_clear.webp', titleKo: '라운지 — 여름 밤 새 디자인', titleEn: 'Lounge — Summer Night New Design', descKo: '밤 조명이 켜진 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge at night', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_autumn_day_sunny.webp', titleKo: '라운지 — 가을 낮 새 디자인', titleEn: 'Lounge — Autumn Day New Design', descKo: '가을빛 정원이 보이는 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge in autumn daylight', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_autumn_day_rain.webp', titleKo: '라운지 — 가을 비 새 디자인', titleEn: 'Lounge — Autumn Rain New Design', descKo: '가을비가 내리는 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on a rainy autumn day', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_autumn_day_storm.webp', titleKo: '라운지 — 가을 폭풍 새 디자인', titleEn: 'Lounge — Autumn Storm New Design', descKo: '폭풍 전후의 어두운 가을빛을 담은 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge in stormy autumn weather', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_autumn_sunset_clear.webp', titleKo: '라운지 — 가을 노을 새 디자인', titleEn: 'Lounge — Autumn Sunset New Design', descKo: '가을 노을빛이 들어오는 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge in autumn sunset light', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_autumn_night_clear.webp', titleKo: '라운지 — 가을 밤 새 디자인', titleEn: 'Lounge — Autumn Night New Design', descKo: '가을밤 조명이 켜진 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on an autumn night', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_winter_day_sunny.webp', titleKo: '라운지 — 겨울 낮 새 디자인', titleEn: 'Lounge — Winter Day New Design', descKo: '맑은 겨울날의 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on a clear winter day', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_winter_day_snow.webp', titleKo: '라운지 — 겨울 눈 새 디자인', titleEn: 'Lounge — Winter Snow New Design', descKo: '눈 내리는 겨울날의 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on a snowy winter day', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_winter_sunset_clear.webp', titleKo: '라운지 — 겨울 노을 새 디자인', titleEn: 'Lounge — Winter Sunset New Design', descKo: '겨울 노을빛이 들어오는 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge in winter sunset light', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_winter_night_clear.webp', titleKo: '라운지 — 겨울 밤 새 디자인', titleEn: 'Lounge — Winter Night New Design', descKo: '겨울밤 조명이 켜진 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on a winter night', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_winter_night_snow.webp', titleKo: '라운지 — 겨울 눈밤 새 디자인', titleEn: 'Lounge — Winter Snowy Night New Design', descKo: '눈 내리는 겨울밤의 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on a snowy winter night', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_winter_day_snow_xmas.webp', titleKo: '라운지 — 크리스마스 낮 새 디자인', titleEn: 'Lounge — Christmas Day New Design', descKo: '크리스마스 장식과 눈 내린 낮의 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on a snowy Christmas day', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_winter_sunset_clear_xmas.webp', titleKo: '라운지 — 크리스마스 노을 새 디자인', titleEn: 'Lounge — Christmas Sunset New Design', descKo: '크리스마스 장식과 겨울 노을이 어우러진 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge in Christmas sunset light', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
    { src: '/gallery/generated/2026-07-design-refresh/lounge/lounge_bg_winter_night_snow_xmas.webp', titleKo: '라운지 — 크리스마스 새 디자인', titleEn: 'Lounge — Christmas New Design', descKo: '크리스마스 장식과 눈 내리는 밤의 카페루아 1층 라운지 새 디자인', descEn: 'New Cafe Lua first-floor lounge on a snowy Christmas night', tagsKo: ['새 디자인', '카페루아 공간', '라운지'], tagsEn: ['New Design', 'Cafe Lua Space', 'Lounge'] },
  ],
  atelier: ATELIER_MATRIX_IMAGES,
  guestbook: makeShowcaseSpaceImages({ key: 'guestbook', folder: 'guestbook-background-img', labelKo: '방명록', labelEn: 'Guestbook' }),
  gallery: makeShowcaseSpaceImages({ key: 'gallery', folder: 'gallery-background-img', labelKo: '갤러리', labelEn: 'Gallery' }),
  about: makeShowcaseSpaceImages({ key: 'about', folder: 'about-background-img', labelKo: '카페 소개', labelEn: 'About Cafe' }),
  masterDesk: makeShowcaseSpaceImages({ key: 'master_desk', folder: 'master-desk-background-img', labelKo: '마스터의 데스크', labelEn: "Master's Desk" }),
  library: makeShowcaseSpaceImages({ key: 'library', folder: 'library-background-img', labelKo: '서재', labelEn: 'Library' }),
  character: newestAlphaFirst([
    { src: '/gallery/legacy/2026-06-design-refresh/alpha-coffee-chat-old.webp', titleKo: '알파 — 커피챗', titleEn: 'Alpha — Coffee Chat', descKo: '커피를 앞에 두고 대화하는 알파', descEn: 'Alpha chatting over coffee' },
    { src: '/gallery/legacy/2026-06-design-refresh/alpha-tarot-ready-old.webp', titleKo: '알파 — 타로 준비', titleEn: 'Alpha — Tarot Ready', descKo: '타로 카드를 준비하는 알파', descEn: 'Alpha preparing tarot cards' },
    { src: '/gallery/generated/2026-06-design-refresh/alpha-coffee-chat-v3-4.webp', titleKo: 'Alpha Coffee Chat v3.4', titleEn: 'Alpha Coffee Chat v3.4', descKo: 'Alpha v3.4 coffee chat illustration, 1376x768', descEn: 'Alpha v3.4 coffee chat illustration, 1376x768', tagsKo: ['New Design', 'Alpha', 'Coffee Chat'], tagsEn: ['New Design', 'Alpha', 'Coffee Chat'] },
    { src: '/characters/alpha/coffee-chat/coffee_chat_spring_day_sunny_a.webp', titleKo: '커피챗 - 봄 낮 맑음', titleEn: 'Coffee Chat - Spring Day Sunny', descKo: '봄 낮 맑은 날의 야외 카페루아 커피챗 이미지', descEn: 'Cafe Lua coffee chat on a sunny spring day', tagsKo: ['새 디자인', '알파', '커피챗', '봄', '낮', '맑음'], tagsEn: ['New Design', 'Alpha', 'Coffee Chat', 'Spring', 'Day', 'Sunny'] },
    { src: '/characters/alpha/coffee-chat/coffee_chat_summer_day_sunny_a.webp', titleKo: '커피챗 - 여름 낮 맑음', titleEn: 'Coffee Chat - Summer Day Sunny', descKo: '여름 낮 맑은 날의 야외 카페루아 커피챗 이미지', descEn: 'Cafe Lua coffee chat on a sunny summer day', tagsKo: ['새 디자인', '알파', '커피챗', '여름', '낮', '맑음'], tagsEn: ['New Design', 'Alpha', 'Coffee Chat', 'Summer', 'Day', 'Sunny'] },
    { src: '/characters/alpha/coffee-chat/coffee_chat_summer_day_rain_a.webp', titleKo: '커피챗 - 여름 낮 비', titleEn: 'Coffee Chat - Summer Day Rain', descKo: '여름비가 내리는 낮의 실내 카페루아 커피챗 이미지', descEn: 'Cafe Lua indoor coffee chat on a rainy summer day', tagsKo: ['새 디자인', '알파', '커피챗', '여름', '낮', '비'], tagsEn: ['New Design', 'Alpha', 'Coffee Chat', 'Summer', 'Day', 'Rain'] },
    { src: '/characters/alpha/coffee-chat/coffee_chat_autumn_sunset_clear_a.webp', titleKo: '커피챗 - 가을 해질녘 맑음', titleEn: 'Coffee Chat - Autumn Sunset Clear', descKo: '가을 해질녘 야외 카페루아 커피챗 이미지', descEn: 'Cafe Lua coffee chat at a clear autumn sunset', tagsKo: ['새 디자인', '알파', '커피챗', '가을', '해질녘', '맑음'], tagsEn: ['New Design', 'Alpha', 'Coffee Chat', 'Autumn', 'Sunset', 'Clear'] },
    { src: '/characters/alpha/coffee-chat/coffee_chat_autumn_night_clear_a.webp', titleKo: '커피챗 - 가을 밤 맑음', titleEn: 'Coffee Chat - Autumn Night Clear', descKo: '가을밤 창밖 단풍이 보이는 카페루아 커피챗 이미지', descEn: 'Cafe Lua coffee chat on a clear autumn night', tagsKo: ['새 디자인', '알파', '커피챗', '가을', '밤', '맑음'], tagsEn: ['New Design', 'Alpha', 'Coffee Chat', 'Autumn', 'Night', 'Clear'] },
    { src: '/characters/alpha/coffee-chat/coffee_chat_winter_night_snow_a.webp', titleKo: '커피챗 - 겨울 밤 눈', titleEn: 'Coffee Chat - Winter Night Snow', descKo: '눈 내리는 겨울밤의 실내 카페루아 커피챗 이미지', descEn: 'Cafe Lua indoor coffee chat on a snowy winter night', tagsKo: ['새 디자인', '알파', '커피챗', '겨울', '밤', '눈'], tagsEn: ['New Design', 'Alpha', 'Coffee Chat', 'Winter', 'Night', 'Snow'] },
    { src: '/characters/alpha/coffee-chat/coffee_chat_night_clear_a.webp', titleKo: '커피챗 - 밤 맑음 공통', titleEn: 'Coffee Chat - Night Clear Fallback', descKo: '맑은 밤에 쓰는 실내 카페루아 커피챗 공통 이미지', descEn: 'Cafe Lua indoor coffee chat fallback for clear nights', tagsKo: ['새 디자인', '알파', '커피챗', '밤', '맑음'], tagsEn: ['New Design', 'Alpha', 'Coffee Chat', 'Night', 'Clear'] },
    { src: '/gallery/generated/2026-06-design-refresh/alpha-tarot-ready-v3-4.webp', titleKo: 'Alpha Tarot Ready v3.4', titleEn: 'Alpha Tarot Ready v3.4', descKo: 'Alpha v3.4 tarot preparation illustration, 1376x768', descEn: 'Alpha v3.4 tarot preparation illustration, 1376x768', tagsKo: ['New Design', 'Alpha', 'Tarot'], tagsEn: ['New Design', 'Alpha', 'Tarot'] },
    { src: '/gallery/legacy/2026-06-design-refresh/alpha-serving-old.webp', titleKo: '알파 — 서빙', titleEn: 'Alpha — Serving', descKo: '음료를 서빙하는 알파', descEn: 'Alpha serving drinks' },
  ]),
  expression: newestAlphaFirst([
    { src: '/gallery/legacy/2026-06-design-refresh/face-variation/alpha-face-old.webp', titleKo: '기본 표정', titleEn: 'Default', descKo: '알파의 기본 표정', descEn: 'Alpha\'s default expression' },
    { src: '/gallery/legacy/2026-06-design-refresh/face-variation/alpha-nice-talk-old.webp', titleKo: '다정함', titleEn: 'Friendly', descKo: '다정하게 이야기하는 표정', descEn: 'Friendly talking expression' },
    { src: '/gallery/legacy/2026-06-design-refresh/face-variation/alpha-wink-smile-old.webp', titleKo: '윙크', titleEn: 'Wink', descKo: '윙크하며 웃는 표정', descEn: 'Winking smile' },
    { src: '/gallery/legacy/2026-06-design-refresh/face-variation/alpha-embarrassment-old.webp', titleKo: '당황', titleEn: 'Embarrassed', descKo: '당황한 표정', descEn: 'Embarrassed expression' },
    { src: '/gallery/legacy/2026-06-design-refresh/face-variation/alpha-trouble-old.webp', titleKo: '곤란', titleEn: 'Troubled', descKo: '곤란한 표정', descEn: 'Troubled expression' },
    { src: '/gallery/legacy/2026-06-design-refresh/face-variation/alpha-pouty-cheeks-old.webp', titleKo: '볼 부풀리기', titleEn: 'Pouty', descKo: '볼을 부풀린 표정', descEn: 'Pouty cheeks expression' },
    { src: '/gallery/legacy/2026-06-design-refresh/face-variation/alpha-disappointed-old.webp', titleKo: '실망', titleEn: 'Disappointed', descKo: '실망한 표정', descEn: 'Disappointed expression' },
    { src: '/gallery/legacy/2026-06-design-refresh/face-variation/alpha-dissatisfaction-old.webp', titleKo: '불만', titleEn: 'Dissatisfied', descKo: '불만스러운 표정', descEn: 'Dissatisfied expression' },
    { src: '/gallery/generated/2026-06-design-refresh/face-variation/alpha-face-v3-4.webp', titleKo: 'Alpha Default v3.4', titleEn: 'Alpha Default v3.4', descKo: 'Alpha v3.4 default face variation, 190x210 transparent WebP', descEn: 'Alpha v3.4 default face variation, 190x210 transparent WebP', tagsKo: ['New Design', 'Alpha', 'Face Variation'], tagsEn: ['New Design', 'Alpha', 'Face Variation'] },
    { src: '/gallery/generated/2026-06-design-refresh/face-variation/alpha-nice-talk-v3-4.webp', titleKo: 'Alpha Friendly v3.4', titleEn: 'Alpha Friendly v3.4', descKo: 'Alpha v3.4 friendly face variation, 190x210 transparent WebP', descEn: 'Alpha v3.4 friendly face variation, 190x210 transparent WebP', tagsKo: ['New Design', 'Alpha', 'Face Variation'], tagsEn: ['New Design', 'Alpha', 'Face Variation'] },
    { src: '/gallery/generated/2026-06-design-refresh/face-variation/alpha-wink-smile-v3-4.webp', titleKo: 'Alpha Wink v3.4', titleEn: 'Alpha Wink v3.4', descKo: 'Alpha v3.4 wink face variation, 190x210 transparent WebP', descEn: 'Alpha v3.4 wink face variation, 190x210 transparent WebP', tagsKo: ['New Design', 'Alpha', 'Face Variation'], tagsEn: ['New Design', 'Alpha', 'Face Variation'] },
    { src: '/gallery/generated/2026-06-design-refresh/face-variation/alpha-embarrassment-v3-4.webp', titleKo: 'Alpha Embarrassed v3.4', titleEn: 'Alpha Embarrassed v3.4', descKo: 'Alpha v3.4 embarrassed face variation, 190x210 transparent WebP', descEn: 'Alpha v3.4 embarrassed face variation, 190x210 transparent WebP', tagsKo: ['New Design', 'Alpha', 'Face Variation'], tagsEn: ['New Design', 'Alpha', 'Face Variation'] },
    { src: '/gallery/generated/2026-06-design-refresh/face-variation/alpha-trouble-v3-4.webp', titleKo: 'Alpha Troubled v3.4', titleEn: 'Alpha Troubled v3.4', descKo: 'Alpha v3.4 troubled face variation, 190x210 transparent WebP', descEn: 'Alpha v3.4 troubled face variation, 190x210 transparent WebP', tagsKo: ['New Design', 'Alpha', 'Face Variation'], tagsEn: ['New Design', 'Alpha', 'Face Variation'] },
    { src: '/gallery/generated/2026-06-design-refresh/face-variation/alpha-pouty-cheeks-v3-4.webp', titleKo: 'Alpha Pouty v3.4', titleEn: 'Alpha Pouty v3.4', descKo: 'Alpha v3.4 pouty cheeks face variation, 190x210 transparent WebP', descEn: 'Alpha v3.4 pouty cheeks face variation, 190x210 transparent WebP', tagsKo: ['New Design', 'Alpha', 'Face Variation'], tagsEn: ['New Design', 'Alpha', 'Face Variation'] },
    { src: '/gallery/generated/2026-06-design-refresh/face-variation/alpha-disappointed-v3-4.webp', titleKo: 'Alpha Disappointed v3.4', titleEn: 'Alpha Disappointed v3.4', descKo: 'Alpha v3.4 disappointed face variation, 190x210 transparent WebP', descEn: 'Alpha v3.4 disappointed face variation, 190x210 transparent WebP', tagsKo: ['New Design', 'Alpha', 'Face Variation'], tagsEn: ['New Design', 'Alpha', 'Face Variation'] },
    { src: '/gallery/generated/2026-06-design-refresh/face-variation/alpha-dissatisfaction-v3-4.webp', titleKo: 'Alpha Dissatisfied v3.4', titleEn: 'Alpha Dissatisfied v3.4', descKo: 'Alpha v3.4 dissatisfied face variation, 190x210 transparent WebP', descEn: 'Alpha v3.4 dissatisfied face variation, 190x210 transparent WebP', tagsKo: ['New Design', 'Alpha', 'Face Variation'], tagsEn: ['New Design', 'Alpha', 'Face Variation'] },
  ]),
  etc: [
    { src: '/undestruct.webp', titleKo: '청소 중!', titleEn: 'Cleaning in Progress!', descKo: '알파가 열심히 공간을 꾸미는 중이에요', descEn: 'Alpha is busy decorating the space' },
    { src: '/gallery/generated/2026-06-design-refresh/intro-logo-new-design.webp', titleKo: '카페루아 원형 로고 새 디자인', titleEn: 'Cafe Lua Round Logo New Design', descKo: '2026 디자인 리프레시 기준의 카페루아 메인 원형 로고', descEn: 'Cafe Lua main round logo for the 2026 design refresh', tagsKo: ['새 디자인', '카페소개', '로고'], tagsEn: ['New Design', 'Cafe Introduction', 'Logo'] },
  ],
};

export const TAROT_DECKS: GalleryDeck[] = [
  {
    key: 'current-major',
    labelKo: 'v2.0 두 이야기',
    labelEn: 'v2.0 Two Stories',
  },
  {
    key: 'old-major',
    labelKo: 'v1.0 원본 삽화',
    labelEn: 'v1.0 Original Illustrations',
    introKo: 'v1.0 카페루아 타로 덱의 원본 삽화 22장입니다. 카드 이름과 짧은 설명을 함께 볼 수 있습니다.',
    introEn: 'The 22 original illustrations from the Cafe Lua Tarot v1.0 deck, with card names and brief descriptions.',
  },
];

const CURRENT_TAROT_CARDS: Pick<GalleryImage, 'src' | 'titleKo' | 'titleEn'>[] = [
  { src: "/tarot/major/00-the-fool.webp", titleKo: "0. 광대", titleEn: "0. The Fool" },
  { src: "/tarot/major/01-the-magician.webp", titleKo: "1. 마법사", titleEn: "1. The Magician" },
  { src: "/tarot/major/02-the-high-priestess.webp", titleKo: "2. 여사제", titleEn: "2. The High Priestess" },
  { src: "/tarot/major/03-the-empress.webp", titleKo: "3. 여황제", titleEn: "3. The Empress" },
  { src: "/tarot/major/04-the-emperor.webp", titleKo: "4. 황제", titleEn: "4. The Emperor" },
  { src: "/tarot/major/05-the-hierophant.webp", titleKo: "5. 교황", titleEn: "5. The Hierophant" },
  { src: "/tarot/major/06-the-lovers.webp", titleKo: "6. 연인", titleEn: "6. The Lovers" },
  { src: "/tarot/major/07-the-chariot.webp", titleKo: "7. 전차", titleEn: "7. The Chariot" },
  { src: "/tarot/major/08-strength.webp", titleKo: "8. 힘", titleEn: "8. Strength" },
  { src: "/tarot/major/09-the-hermit.webp", titleKo: "9. 은둔자", titleEn: "9. The Hermit" },
  { src: "/tarot/major/10-wheel-of-fortune.webp", titleKo: "10. 운명의 수레바퀴", titleEn: "10. Wheel of Fortune" },
  { src: "/tarot/major/11-justice.webp", titleKo: "11. 정의", titleEn: "11. Justice" },
  { src: "/tarot/major/12-the-hanged-man.webp", titleKo: "12. 매달린 사람", titleEn: "12. The Hanged Man" },
  { src: "/tarot/major/13-death.webp", titleKo: "13. 죽음", titleEn: "13. Death" },
  { src: "/tarot/major/14-temperance.webp", titleKo: "14. 절제", titleEn: "14. Temperance" },
  { src: "/tarot/major/15-the-devil.webp", titleKo: "15. 악마", titleEn: "15. The Devil" },
  { src: "/tarot/major/16-the-tower.webp", titleKo: "16. 탑", titleEn: "16. The Tower" },
  { src: "/tarot/major/17-the-star.webp", titleKo: "17. 별", titleEn: "17. The Star" },
  { src: "/tarot/major/18-the-moon.webp", titleKo: "18. 달", titleEn: "18. The Moon" },
  { src: "/tarot/major/19-the-sun.webp", titleKo: "19. 태양", titleEn: "19. The Sun" },
  { src: "/tarot/major/20-judgement.webp", titleKo: "20. 심판", titleEn: "20. Judgement" },
  { src: "/tarot/major/21-the-world.webp", titleKo: "21. 세계", titleEn: "21. The World" }
];

const OLD_TAROT_DESCRIPTIONS: Pick<GalleryImage, 'descKo' | 'descEn'>[] = [
  { descKo: "밝은 정원과 검은 고양이", descEn: "Bright garden and black cat" },
  { descKo: "디지털 책상 위의 빛", descEn: "Digital light on the desk" },
  { descKo: "기둥 사이의 달빛", descEn: "Moonlight between pillars" },
  { descKo: "햇빛 꽃밭", descEn: "Sunlit flower field" },
  { descKo: "모니터 벽의 통제실", descEn: "Control room wall of monitors" },
  { descKo: "도면 앞의 수업", descEn: "Lesson before diagrams" },
  { descKo: "황금빛 정원에서 마주 섬", descEn: "Facing each other in golden garden" },
  { descKo: "두 고양이와 서빙 카트", descEn: "Serving cart with two cats" },
  { descKo: "창가의 검은 고양이", descEn: "Black cat by the window" },
  { descKo: "모니터 앞의 밤 작업", descEn: "Night work before the monitor" },
  { descKo: "카페 테이블의 운세판", descEn: "Fortune table in the cafe" },
  { descKo: "카페 카운터의 저울", descEn: "Scales at the cafe counter" },
  { descKo: "낮빛 소파 위 거꾸로 누움", descEn: "Upside down on the daytime sofa" },
  { descKo: "모래시계와 검은 고양이", descEn: "Hourglass and black cat" },
  { descKo: "카페 주방의 음료", descEn: "Drink in the cafe kitchen" },
  { descKo: "붉은 모니터의 늦은 작업", descEn: "Late work by red monitors" },
  { descKo: "실내 장비 폭발", descEn: "Equipment explosion indoors" },
  { descKo: "발코니의 큰 별", descEn: "Big star over the balcony" },
  { descKo: "보름달 창과 고양이 그림자", descEn: "Full moon window and cat shadow" },
  { descKo: "해바라기 야외 카페", descEn: "Sunflower outdoor cafe" },
  { descKo: "빛의 문 앞 알파", descEn: "Alpha before the door of light" },
  { descKo: "원환 안의 알파와 아래의 루크", descEn: "Alpha in the ring and Luke below" }
];

const STORY_TAROT_CARDS: GalleryImage[] = CURRENT_TAROT_CARDS.map((card, index) => {
  const fable = TAROT_STORY_EDITIONS.fable.chapters[index];
  const astra = TAROT_STORY_EDITIONS.astra.chapters[index];
  if (!fable || !astra) throw new Error(`Missing tarot story chapter ${index}`);

  return {
    ...card,
    descKo: fable.summaryKo,
    descEn: fable.summaryEn,
    deckIds: ['current-major'],
    tarotStories: { fable, astra },
  };
});

const OLD_TAROT_CARDS: GalleryImage[] = CURRENT_TAROT_CARDS.map((card, index) => {
  const description = OLD_TAROT_DESCRIPTIONS[index];
  if (!description) throw new Error(`Missing v1.0 tarot description ${index}`);

  return {
    src: card.src.replace('/tarot/major/', '/tarot/major-old/'),
    titleKo: card.titleKo,
    titleEn: card.titleEn,
    descKo: description.descKo,
    descEn: description.descEn,
    deckIds: ['old-major'],
  };
});

export const TAROT_CARDS: GalleryImage[] = [
  ...STORY_TAROT_CARDS,
  ...OLD_TAROT_CARDS,
];

export const BGM_LIST: GalleryMusic[] = [
  { src: '/sounds/intro.mp3', titleKo: '숲 끝자락의 문', titleEn: 'The Door at Forest\'s Edge', descKo: '카페루아의 입구에서 흐르는 음악', descEn: 'Music playing at the entrance of Cafe Lua', usedIn: 'intro' },
  { src: '/sounds/lounge.mp3', titleKo: '라운지의 오후', titleEn: 'Afternoon in the Lounge', descKo: '라운지에서 흐르는 따뜻한 선율', descEn: 'A warm melody flowing through the lounge', usedIn: 'lounge' },
  { src: '/sounds/atelier.mp3', titleKo: '아틀리에의 고요', titleEn: 'Stillness of the Atelier', descKo: '2층 작업 공간의 잔잔한 배경음악', descEn: 'Calm background music of the 2F workspace', usedIn: 'atelier' },
  { src: '/sounds/master-desk.mp3', titleKo: '한 페이지만 더', titleEn: 'One More Page', descKo: '마스터의 데스크에서 글을 읽을 때 흐르는 음악', descEn: "Music for reading at the Master's Desk", usedIn: 'masterDesk' },
  { src: '/sounds/library.mp3', titleKo: '천천히 넘기는 페이지', titleEn: 'Slow Turning Pages', descKo: '2층 서재에서 책장을 넘길 때 흐르는 음악', descEn: 'Music for turning pages in the second-floor Library', usedIn: 'library' },
  { src: '/sounds/coffee-chat.mp3', titleKo: '커피 한 잔의 대화', titleEn: 'A Chat Over Coffee', descKo: '알파와 커피챗을 할 때 흐르는 음악', descEn: 'Music playing during a coffee chat with Alpha', usedIn: 'coffeeChat' },
  { src: '/sounds/taro-bgm.mp3', titleKo: '별빛 아래 카드', titleEn: 'Cards Under Starlight', descKo: '타로 상담 시 흐르는 신비로운 음악', descEn: 'Mystical music during tarot readings', usedIn: 'tarot' },
  { src: '/sounds/gallery.mp3', titleKo: '갤러리의 여운', titleEn: 'Gallery Reverie', descKo: '갤러리에서 흐르는 잔잔한 음악', descEn: 'Gentle music flowing through the gallery', usedIn: 'gallery' },
];

export const SPACE_SUBCATEGORIES = [
  { key: 'intro', labelKo: '인트로(현관)', labelEn: 'Intro (Entrance)' },
  { key: 'lounge', labelKo: '라운지(1F)', labelEn: 'Lounge (1F)' },
  { key: 'atelier', labelKo: '아틀리에(2F)', labelEn: 'Atelier (2F)' },
  { key: 'library', labelKo: '서재(2F)', labelEn: 'Library (2F)' },
  { key: 'masterDesk', labelKo: '마스터의 데스크', labelEn: "Master's Desk" },
  { key: 'guestbook', labelKo: '방명록', labelEn: 'Guestbook' },
  { key: 'gallery', labelKo: '갤러리', labelEn: 'Gallery' },
  { key: 'about', labelKo: '카페 소개', labelEn: 'About Cafe' },
  { key: 'etc', labelKo: '기타', labelEn: 'Others' },
  { key: 'character', labelKo: '캐릭터', labelEn: 'Characters' },
  { key: 'expression', labelKo: '표정', labelEn: 'Expressions' },
];
