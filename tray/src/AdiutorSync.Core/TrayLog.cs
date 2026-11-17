using System.Globalization;
using System.Text;

namespace AdiutorSync.Core;

public interface ITrayLog
{
    void Info(string line);
}

/// <summary>
/// The tray's own log, tray.log in the data folder, kept under 512 KB with one older file. It holds what the tray did
/// and the engine's stable codes only: never the engine's output, its messages, a token, a project name or a thread
/// title (the plan, "Secrets map").
/// </summary>
public sealed class TrayLog(string path) : ITrayLog
{
    private const long MaxBytes = 512 * 1024;
    private readonly Lock _gate = new();

    public void Info(string line)
    {
        lock (_gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                if (File.Exists(path) && new FileInfo(path).Length > MaxBytes)
                    File.Move(path, path + ".1", overwrite: true);
                var stamp = DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture);
                File.AppendAllText(path, $"{stamp} {line}{Environment.NewLine}", Encoding.UTF8);
            }
            catch (IOException)
            {
                // The log is best effort: a full disk or a locked file never stops the tray.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}

public sealed class NoLog : ITrayLog
{
    public static readonly NoLog Instance = new();

    public void Info(string line)
    {
    }
}
