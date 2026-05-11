import { useEffect, useState } from "react";

interface SplashScreenProps {
	onDone: () => void;
	/** Gate: splash won't begin fading until this is true. Prevents premature dismiss. */
	ready?: boolean;
	minDuration?: number;
}

export function SplashScreen({
	onDone,
	ready = false,
	minDuration = 2000,
}: SplashScreenProps) {
	const [fading, setFading] = useState(false);
	const [minElapsed, setMinElapsed] = useState(false);

	// Track minimum display duration independently of readiness
	useEffect(() => {
		const t = setTimeout(() => setMinElapsed(true), minDuration);
		return () => clearTimeout(t);
	}, [minDuration]);

	// Start fade only when BOTH min duration has elapsed AND app is ready
	useEffect(() => {
		if (!minElapsed || !ready) return;
		setFading(true);
		const doneTimer = setTimeout(onDone, 500); // matches CSS fade duration
		return () => clearTimeout(doneTimer);
	}, [minElapsed, ready, onDone]);

	return (
		<div className={`splash-screen${fading ? " splash-screen--fade" : ""}`}>
			{/* Circuit flow lines at bottom */}
			<svg
				className="splash-circuit"
				viewBox="0 0 1200 120"
				preserveAspectRatio="none"
			>
				<defs>
					<linearGradient id="flowGrad1" x1="0%" y1="0%" x2="100%" y2="0%">
						<stop offset="0%" stopColor="transparent" />
						<stop offset="40%" stopColor="#22d3ee" stopOpacity="0.6" />
						<stop offset="60%" stopColor="#22d3ee" stopOpacity="0.6" />
						<stop offset="100%" stopColor="transparent" />
					</linearGradient>
					<linearGradient id="flowGrad2" x1="0%" y1="0%" x2="100%" y2="0%">
						<stop offset="0%" stopColor="transparent" />
						<stop offset="30%" stopColor="#06b6d4" stopOpacity="0.4" />
						<stop offset="70%" stopColor="#06b6d4" stopOpacity="0.4" />
						<stop offset="100%" stopColor="transparent" />
					</linearGradient>
				</defs>
				{/* Horizontal flowing lines */}
				<line
					className="splash-flow-line splash-flow-line--1"
					x1="0"
					y1="40"
					x2="1200"
					y2="40"
					stroke="url(#flowGrad1)"
					strokeWidth="1.5"
				/>
				<line
					className="splash-flow-line splash-flow-line--2"
					x1="0"
					y1="65"
					x2="1200"
					y2="65"
					stroke="url(#flowGrad2)"
					strokeWidth="1"
				/>
				<line
					className="splash-flow-line splash-flow-line--3"
					x1="0"
					y1="90"
					x2="1200"
					y2="90"
					stroke="url(#flowGrad1)"
					strokeWidth="0.8"
				/>
				{/* Nodes on lines */}
				<circle
					className="splash-flow-node splash-flow-node--1"
					cx="300"
					cy="40"
					r="3"
					fill="#22d3ee"
				/>
				<circle
					className="splash-flow-node splash-flow-node--2"
					cx="600"
					cy="65"
					r="3"
					fill="#06b6d4"
				/>
				<circle
					className="splash-flow-node splash-flow-node--3"
					cx="900"
					cy="40"
					r="3"
					fill="#22d3ee"
				/>
				<circle
					className="splash-flow-node splash-flow-node--4"
					cx="450"
					cy="90"
					r="2.5"
					fill="#06b6d4"
				/>
				<circle
					className="splash-flow-node splash-flow-node--5"
					cx="750"
					cy="90"
					r="2.5"
					fill="#22d3ee"
				/>
			</svg>

			<div className="splash-content">
				{/* Logo */}
				<div className="splash-logo-wrap">
					<div className="splash-logo-spin">
						<img
							src="/brand/naia-logo.png"
							alt="Naia"
							className="splash-logo-mark"
						/>
					</div>
					{/* Outer ring */}
					<div className="splash-ring" />
				</div>

				{/* "Naia" text fade-in */}
				<div className="splash-logo-text">Naia</div>

				{/* Loading dots */}
				<div className="splash-dots">
					<span className="splash-dot" />
					<span className="splash-dot" />
					<span className="splash-dot" />
				</div>
			</div>
		</div>
	);
}
