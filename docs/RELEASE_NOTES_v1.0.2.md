# StashDock 1.0.2 for Windows

Fixes a startup failure on Windows systems where Explorer belongs to a Job Object.
StashDock now verifies the Explorer creation parent before starting its independent
desktop process, allowing legitimate shell-owned jobs.

Download `StashDock_1.0.2_x64-setup.exe` for Windows 10 or 11, x64.
The Windows ChatGPT plugin remains at 1.0.1. Mac downloads remain in
[1.0.0](https://github.com/StashDock/StashDock/releases/tag/v1.0.0).

This Windows installer is unsigned. Windows SmartScreen may show an unrecognized
application warning. If you have verified the official download and trust it,
select **More info**, then **Run anyway**, when your Windows policy permits it.
This release fixes the application's startup check; it does not remove Windows
security warnings. Do not disable Windows security protections.

`SHA256SUMS.txt` contains checksums for the release downloads.
