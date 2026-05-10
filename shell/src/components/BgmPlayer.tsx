import { useEffect, useRef, useState } from "react";
import { listNaiaAssets, toLocalBlobUrl } from "../lib/adk-store";
import { Logger } from "../lib/logger";
import { useAvatarStore } from "../stores/avatar";

export function BgmPlayer() {
	const audioRef = useRef<HTMLAudioElement>(null);
	const bgmTrackUrl = useAvatarStore((s) => s.bgmTrackUrl);
	const setBgmTrackUrl = useAvatarStore((s) => s.setBgmTrackUrl);
	const [tracks, setTracks] = useState<string[]>([]);
	const [trackNames, setTrackNames] = useState<string[]>([]);
	const [currentIndex, setCurrentIndex] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [volume, setVolume] = useState(0.3);

	// Load available tracks from naia-settings/bgm-musics/
	useEffect(() => {
		listNaiaAssets("bgm-musics").then(async (paths) => {
			const urls = await Promise.all(paths.map(toLocalBlobUrl));
			const names = paths.map(
				(p) =>
					p
						.split(/[\\/]/)
						.pop()
						?.replace(/\.[^.]+$/, "") ?? p,
			);
			setTracks(urls);
			setTrackNames(names);
			if (urls.length > 0 && !bgmTrackUrl) {
				setBgmTrackUrl(urls[0]);
			}
		});
	}, []);

	// Sync audio src with store
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio || !bgmTrackUrl) return;
		const idx = tracks.indexOf(bgmTrackUrl);
		if (idx >= 0) setCurrentIndex(idx);
		if (audio.src !== bgmTrackUrl) {
			audio.src = bgmTrackUrl;
			if (playing) {
				audio.play().catch((err) => {
					Logger.error("BgmPlayer", "sync play failed", {
						error: String(err),
						src: bgmTrackUrl,
					});
				});
			}
		}
	}, [bgmTrackUrl, tracks]);

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;
		audio.volume = volume;
	}, [volume]);

	function togglePlay() {
		const audio = audioRef.current;
		if (!audio) return;
		if (playing) {
			audio.pause();
			setPlaying(false);
		} else {
			if (
				tracks.length > 0 &&
				(!audio.src || audio.src === window.location.href)
			) {
				audio.src = tracks[currentIndex];
			}
			audio
				.play()
				.then(() => setPlaying(true))
				.catch((err) => {
					Logger.error("BgmPlayer", "play failed", {
						error: String(err),
						src: audio.src,
					});
				});
		}
	}

	function playNext() {
		if (tracks.length === 0) return;
		const next = (currentIndex + 1) % tracks.length;
		setCurrentIndex(next);
		setBgmTrackUrl(tracks[next]);
		const audio = audioRef.current;
		if (audio) {
			audio.src = tracks[next];
			if (playing)
				audio
					.play()
					.catch((err) =>
						Logger.error("BgmPlayer", "next play failed", {
							error: String(err),
						}),
					);
		}
	}

	function playPrev() {
		if (tracks.length === 0) return;
		const prev = (currentIndex - 1 + tracks.length) % tracks.length;
		setCurrentIndex(prev);
		setBgmTrackUrl(tracks[prev]);
		const audio = audioRef.current;
		if (audio) {
			audio.src = tracks[prev];
			if (playing)
				audio
					.play()
					.catch((err) =>
						Logger.error("BgmPlayer", "prev play failed", {
							error: String(err),
						}),
					);
		}
	}

	if (tracks.length === 0) return null;

	return (
		<div className="bgm-player">
			<audio
				ref={audioRef}
				loop={tracks.length <= 1}
				onEnded={playNext}
				onError={(e) => {
					const audio = e.currentTarget;
					Logger.error("BgmPlayer", "audio load error", {
						src: audio.src,
						code: audio.error?.code,
						message: audio.error?.message,
					});
					setPlaying(false);
				}}
			/>
			<div className="bgm-player-controls">
				<button
					type="button"
					className="bgm-btn"
					onClick={playPrev}
					title="이전"
				>
					‹
				</button>
				<button
					type="button"
					className="bgm-btn bgm-btn--play"
					onClick={togglePlay}
					title={playing ? "일시정지" : "재생"}
				>
					{playing ? "⏸" : "▶"}
				</button>
				<button
					type="button"
					className="bgm-btn"
					onClick={playNext}
					title="다음"
				>
					›
				</button>
				<span className="bgm-track-name" title={trackNames[currentIndex]}>
					{trackNames[currentIndex]}
				</span>
				<input
					type="range"
					className="bgm-volume"
					min={0}
					max={1}
					step={0.05}
					value={volume}
					onChange={(e) => setVolume(Number(e.target.value))}
					title="볼륨"
				/>
			</div>
		</div>
	);
}
