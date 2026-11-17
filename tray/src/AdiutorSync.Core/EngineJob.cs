using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AdiutorSync.Core;

/// <summary>
/// One Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (documented Win32: CreateJobObjectW,
/// SetInformationJobObject). Every engine process is created in it (JobProcess:
/// PROC_THREAD_ATTRIBUTE_JOB_LIST), before it runs any code, and its children (the T3 CLI, the collector) are created inside it. When the
/// tray ends, however it ends, Windows closes the job's last handle and ends every process in it, so no engine or
/// child of the engine outlives the tray (the plan, "Process tree").
/// </summary>
public sealed partial class EngineJob : IDisposable
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    private readonly SafeFileHandle _handle;

    public EngineJob()
    {
        _handle = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        if (_handle.IsInvalid)
            throw new InvalidOperationException($"CreateJobObject failed ({Marshal.GetLastPInvokeError()})");
        var info = new ExtendedLimitInformation { BasicLimitInformation = { LimitFlags = JobObjectLimitKillOnJobClose } };
        if (!SetInformationJobObject(_handle, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf<ExtendedLimitInformation>()))
        {
            var error = Marshal.GetLastPInvokeError();
            _handle.Dispose();
            throw new InvalidOperationException($"SetInformationJobObject failed ({error})");
        }
    }

    /** The job's handle, for a process created in it (JobProcess). */
    internal SafeFileHandle Handle => _handle;

    /** Whether a running process is in this job (for the tests). */
    internal bool Contains(int processId)
    {
        using var process = Process.GetProcessById(processId);
        return IsProcessInJob(process.Handle, _handle, out var inJob) && inJob;
    }

    /** Closes the job: every process still in it ends. */
    public void Dispose() => _handle.Dispose();

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial SafeFileHandle CreateJobObjectW(IntPtr attributes, IntPtr name);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimitInformation info, uint length);


    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsProcessInJob(IntPtr process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool result);
}
