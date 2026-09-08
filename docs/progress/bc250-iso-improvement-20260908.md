# BC250 installation candidate — naia-os issue1

P01 scenario: Boot an AMD BC250 from spare installation media, enter the
Naia live desktop, install the exact embedded0.2.3 image, then boot the installed
system. Preserve the running live/workspace USB and internal data. The user
explicitly requested public BC250 source-based improvements for testing tomorrow.

P02/P03 acceptance: retain the pinned shell RPM and signing key; preserve
BIOS/UEFI and basic-graphics recovery; bind the Kickstart reference to the
embedded container; include guarded DP-audio support in the
installed image as well as the live rootfs; preserve icon alpha; never change
production latest or the public download pointer. Exact checksum and USB
readback are required before delivery. Hardware boot/install stays unverified
until actually performed. Source baseline workflow b5156d4f, image48779b61.

P04 tests: installer/bc250/test-bc250.py in the pinned image source exercises
GPU identity/readiness, nomodeset/safe escape, DRM-card selection, exact audio
signature and short reads. Build runs pinned archive/RPM hashes, shell syntax,
image payload/signature checks, BIOS/UEFI validation and served-body SHA256.
Do not equate those checks with actual Anaconda installation or hardware
stability. The local hardware-checksum mismatch belongs to the old downloaded
file, not to the remote candidate build.

P05: pending actual image/ISO build, local checksum, spare-media readback and
human-installed boot. No release promotion.

Development review rejected automatic GPU voltage control: per-board stability,
concurrent controller handling and upstream error cleanup were unverified. The
support2 candidate excludes the governor binary, profile, wrapper and service.
DP audio and installer reference fixes remain. Normal graphics boot is a separate
unresolved acceptance criterion: current BC250 boot uses amdgpu without nomodeset,
kernel7.2.0-ogc6.1.fc44, but previous failure-stage evidence is insufficient.
Do not claim this package fixes pre-render-node graphics initialization. Actual
normal/recovery boot, DP audio and Anaconda deployment must be tested on hardware.

Support3 adds bounded120 consecutive retries with fresh register discovery for delayed GPU access and transient modeset/read errors. Ten fixtures cover identity, signatures, readback races, recovery command lines and retry limits. CI executes these before image publication. No governor is included.
