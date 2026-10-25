/** Shared icon for the fixed App Store action and the AppBar add dialog. */
export function AppStoreIcon() {
	return (
		<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
			<rect x="4" y="9" width="24" height="19" rx="5" fill="#5b67f1" />
			<path
				d="M11 10V8a5 5 0 0 1 10 0v2"
				fill="none"
				stroke="white"
				strokeWidth="2.5"
				strokeLinecap="round"
			/>
			<rect x="9" y="15" width="5" height="5" rx="1.2" fill="white" />
			<rect x="18" y="15" width="5" height="5" rx="1.2" fill="white" />
			<rect
				x="9"
				y="22"
				width="5"
				height="3"
				rx="1.2"
				fill="white"
				opacity=".85"
			/>
			<rect
				x="18"
				y="22"
				width="5"
				height="3"
				rx="1.2"
				fill="white"
				opacity=".85"
			/>
		</svg>
	);
}
