import { useCallback, useRef } from "react";

export function useLongPress(
	onLongPress: () => void,
	onClick: () => void,
	ms = 500,
) {
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isLongPress = useRef(false);

	const start = useCallback(() => {
		isLongPress.current = false;
		timerRef.current = setTimeout(() => {
			isLongPress.current = true;
			onLongPress();
		}, ms);
	}, [onLongPress, ms]);

	const clear = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const click = useCallback(
		(_e: React.MouseEvent | React.TouchEvent) => {
			clear();
			if (!isLongPress.current) {
				onClick();
			}
		},
		[onClick, clear],
	);

	return {
		onMouseDown: start,
		onTouchStart: start,
		onMouseUp: click,
		onTouchEnd: click,
		onMouseLeave: clear,
		onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
	};
}
