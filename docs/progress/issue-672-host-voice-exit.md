# Issue 672 — Host TensorRT runtime exit diagnostics

Issue: https://github.com/nextain/naia-shell/issues/672

`tauri:dev` on Windows showed install progress stuck near 40%, then
"호스트 음성 모델을 준비하고 있습니다", then:

`Naia Host TensorRT runtime exited before readiness (None).`

stdout disconnect used `try_wait()` → `None`, formatted with `{status:?}`.
The stderr log (WDAC / os error 4551 / `voxcpm2_tensorrt.activation` DLL)
was not in the user-visible error. Windows installer also stopped emitting
progress at 40% (palette ready) while NVIDIA packages, model, and engine
still ran.

This change:

1. Formats the real exit reason and appends the stderr tail. Never `(None)`
   as the only status.
2. Emits `voxcpm2_install_progress {phase:"failed"}` and clears the 40% bar
   when install/start fails.
3. Does not inherit `VOXCPM_DEVICE=cpu` when a GPU was selected.

4060 field QA is out of this patch's scope.
