use super::*;

pub(super) fn spawn_owned_child(command: &mut Command) -> std::io::Result<(Child, ChildOwnership)> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        // Keep the primary thread suspended until the process is assigned to
        // our kill-on-close Job Object. LibreOffice's console launcher can
        // otherwise create soffice.bin in the small window between spawn and
        // ownership attachment.
        command.creation_flags(0x08000000 | 0x00000004);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        // Keep the launcher and any soffice.bin descendant in a private
        // process group so cancellation cannot leave an owned worker behind.
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let ownership = match ChildOwnership::attach(&child) {
        Ok(ownership) => ownership,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    #[cfg(windows)]
    if let Err(error) = resume_suspended_child(&child) {
        ownership.terminate();
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok((child, ownership))
}

#[cfg(windows)]
fn resume_suspended_child(child: &Child) -> std::io::Result<()> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut found = false;
    let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) != 0 };
    while has_entry {
        if entry.th32OwnerProcessID == child.id() {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                let resumed = unsafe { ResumeThread(thread) };
                unsafe { CloseHandle(thread) };
                if resumed != u32::MAX {
                    found = true;
                    break;
                }
            }
        }
        has_entry = unsafe { Thread32Next(snapshot, &mut entry) != 0 };
    }
    unsafe { CloseHandle(snapshot) };
    if found {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(super) struct ChildOwnership {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(unix)]
pub(super) struct ChildOwnership {
    pgid: libc::pid_t,
}

#[cfg(all(not(windows), not(unix)))]
pub(super) struct ChildOwnership;

impl ChildOwnership {
    fn attach(child: &Child) -> std::io::Result<Self> {
        #[cfg(windows)]
        {
            use std::mem::{size_of, zeroed};
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };

            // A kill-on-close Job Object owns the console launcher and any
            // soffice.bin descendant it creates. This keeps timeout/cancel
            // cleanup scoped to the process tree started for this request.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const std::ffi::c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) != 0
            };
            let assigned = configured
                && unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as _) != 0 };
            if !assigned {
                unsafe { CloseHandle(handle) };
                return Err(std::io::Error::last_os_error());
            }
            return Ok(Self { handle });
        }
        #[cfg(unix)]
        {
            Ok(Self {
                pgid: child.id() as libc::pid_t,
            })
        }
        #[cfg(all(not(windows), not(unix)))]
        {
            let _ = child;
            Ok(Self)
        }
    }

    pub(super) fn terminate(&self) {
        #[cfg(windows)]
        unsafe {
            let _ = windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1);
        }
        #[cfg(unix)]
        unsafe {
            let _ = libc::kill(-self.pgid, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
impl Drop for ChildOwnership {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(unix)]
impl Drop for ChildOwnership {
    fn drop(&mut self) {
        self.terminate();
    }
}

pub(super) fn kill_child(child: &mut Child, ownership: &ChildOwnership) {
    ownership.terminate();
    let _ = child.kill();
}

pub(super) fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let _ = command;
}
