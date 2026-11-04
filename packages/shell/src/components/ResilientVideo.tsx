import { useEffect, useRef, useState, type VideoHTMLAttributes } from "react";
import { Logger } from "../lib/logger";

/** Keep failed media mounted: src reset/load can deadlock WebKitGTK teardown. */
export function ResilientVideo(props: VideoHTMLAttributes<HTMLVideoElement>) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		let disposed = false;
		const fail = () => {
			if (disposed) return;
			Logger.warn("ResilientVideo", "using still image after media failure");
			setFailed(true);
			video.pause();
			clearTimeout(timer);
		};
		const ready = () => clearTimeout(timer);
		const timer = setTimeout(fail, 8000);
		video.addEventListener("error", fail);
		video.addEventListener("playing", ready);
		if (props.autoPlay) void video.play()?.catch((error) => {
            // A successful thumbnail capture deliberately pauses the decoder.
            if (error?.name === "AbortError") ready();
            else fail();
        });
		return () => {
			disposed = true;
			clearTimeout(timer);
			video.removeEventListener("error", fail);
			video.removeEventListener("playing", ready);
			video.pause();
		};
	}, []);
	return (
		<>
			<video
				{...props}
				ref={videoRef}
				className={failed ? undefined : props.className}
				style={{ ...props.style, ...(failed ? { display: "none" } : {}) }}
			/>
			{failed && (
				<img
					data-media-fallback
					src={props.poster || "/avatars/Naia.webp"}
					className={props.className}
					style={props.style}
					alt={props["aria-label"] || ""}
				/>
			)}
		</>
	);
}
