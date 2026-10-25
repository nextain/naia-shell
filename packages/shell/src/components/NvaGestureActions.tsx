import { getCameraActions } from "../lib/avatar/camera-actions";
import { nvaGestureShortcutLabel } from "../lib/avatar/nva-action-hotkeys";
import { t } from "../lib/i18n";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";

interface Props {
	onManualAction?: (key: string) => void;
}

/** Active NVA gestures beside the chat input, with the corresponding shortcut. */
export function NvaGestureActions({ onManualAction }: Props) {
	const renderer = useCascadeAvatarStore((state) => state.renderer);
	const actions = renderer ? getCameraActions().getGestureActions() : [];
	if (actions.length === 0) return null;

	return (
		<fieldset className="nva-gesture-actions" data-testid="nva-gesture-actions">
			<legend className="nva-gesture-actions__legend">
				{t("ai.avatarGestures")}
			</legend>
			{actions.map((action, index) => {
				const shortcut = nvaGestureShortcutLabel(index);
				const accessibleName = shortcut
					? `${action.label} (${shortcut})`
					: action.label;
				return (
					<button
						key={action.key}
						type="button"
						className="nva-gesture-actions__button"
						aria-label={accessibleName}
						title={accessibleName}
						data-nva-gesture-key={action.key}
						onClick={() => {
							const cameraActions = getCameraActions();
							if (!useCascadeAvatarStore.getState().renderer) return;
							if (
								!cameraActions
									.getGestureActions()
									.some((currentAction) => currentAction.key === action.key)
							)
								return;
							void cameraActions
								.playAction(action.key)
								.then((started) => {
									if (started) onManualAction?.(action.key);
								})
								.catch(() => {});
						}}
					>
						<span className="nva-gesture-actions__label">{action.label}</span>
						{shortcut && (
							<kbd className="nva-gesture-actions__shortcut">{shortcut}</kbd>
						)}
					</button>
				);
			})}
		</fieldset>
	);
}
