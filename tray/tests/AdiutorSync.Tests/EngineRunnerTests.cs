using System.Diagnostics;
using AdiutorSync.Core;

namespace AdiutorSync.Tests;

// The engine runner at its real seam: node.exe with a stand-in engine script, inside a Job Object. Needs node.exe on
// PATH (the Windows CI runner has it).
public class EngineRunnerTests
{
    private static EngineLocation Location()
    {
        var node = EngineLocator.FindOnPath("node.exe", Environment.GetEnvironmentVariable("PATH"));
        Assert.True(node is not null, "node.exe must be on PATH for the runner tests");
        return new EngineLocation(node!, Path.Combine(AppContext.BaseDirectory, "Fixtures", "stand-in-engine.mjs"));
    }

    [Fact]
    public async Task Reads_events_and_the_result_and_adds_json()
    {
        using var job = new EngineJob();
        var engine = new NodeEngine(Location(), job, NoLog.Instance);
        var events = new List<EngineEvent>();
        var outcome = await engine.RunAsync(new EngineCommand(["status"], TimeSpan.FromSeconds(30), OnEvent: events.Add), CancellationToken.None);
        Assert.Null(outcome.Failure);
        Assert.Equal("status", outcome.Result!.Command);
        Assert.Equal(ConnectionState.NotConnected, outcome.Result.Status!.T3.State);
        Assert.Equal("hello", Assert.IsType<MessageEvent>(Assert.Single(events)).Text);
        Assert.Equal(0, engine.Active);
    }

    [Fact]
    public async Task Passes_stdin_and_arguments_as_they_are()
    {
        using var job = new EngineJob();
        var engine = new NodeEngine(Location(), job, NoLog.Instance);
        var events = new List<EngineEvent>();
        // Spaces, quotes and Hebrew (escaped here: Hebrew text lives only in the locale file) reach the engine whole.
        var arg = "a \"b\" c \u05E9\u05DC\u05D5\u05DD";
        var input = """{"version":"1.0.0","note":"\u05D0"}""";
        var outcome = await engine.RunAsync(new EngineCommand(["echo", arg], TimeSpan.FromSeconds(30), input, events.Add), CancellationToken.None);
        Assert.True(outcome.Result!.Ok);
        var texts = events.OfType<MessageEvent>().Select(e => e.Text).ToList();
        Assert.Equal(input, texts[0]);
        Assert.Equal($"[\"{arg.Replace("\"", "\\\"", StringComparison.Ordinal)}\",\"--json\"]", texts[1]);
    }

    [Fact]
    public async Task Without_a_result_the_command_failed_whatever_the_exit_code()
    {
        using var job = new EngineJob();
        var engine = new NodeEngine(Location(), job, NoLog.Instance);
        var outcome = await engine.RunAsync(new EngineCommand(["nothing"], TimeSpan.FromSeconds(30)), CancellationToken.None);
        Assert.Null(outcome.Result);
        Assert.Equal("no_result", outcome.Failure);
    }

    [Fact]
    public async Task A_command_past_its_limit_is_ended()
    {
        using var job = new EngineJob();
        var engine = new NodeEngine(Location(), job, NoLog.Instance);
        var watch = Stopwatch.StartNew();
        var outcome = await engine.RunAsync(new EngineCommand(["hang"], TimeSpan.FromSeconds(2)), CancellationToken.None);
        Assert.Equal("timeout", outcome.Failure);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(20));
        Assert.Equal(0, engine.Active);
    }

    [Fact]
    public async Task Closing_the_job_ends_the_engine_and_its_children()
    {
        var job = new EngineJob();
        var engine = new NodeEngine(Location(), job, NoLog.Instance);
        var childPid = new TaskCompletionSource<int>();
        var run = engine.RunAsync(
            new EngineCommand(["spawn"], TimeSpan.FromMinutes(2), OnEvent: e =>
            {
                if (e is MessageEvent m && int.TryParse(m.Text, out var pid))
                    childPid.TrySetResult(pid);
            }),
            TestContext.Current.CancellationToken);
        var pid = await childPid.Task.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        using var child = Process.GetProcessById(pid);
        Assert.False(child.HasExited);

        // What happens when the tray ends: the last handle of the job closes.
        job.Dispose();
        Assert.True(child.WaitForExit(TimeSpan.FromSeconds(15)), "the engine's child outlived the job");
        var outcome = await run.WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken);
        Assert.Null(outcome.Result);
    }

    [Fact]
    public void Locator_prefers_the_installed_engine_and_needs_full_paths()
    {
        using var dir = new TempFolder();
        File.WriteAllText(dir.File("node.exe"), "");
        File.WriteAllText(dir.File("adiutor-sync.js"), "");
        var found = EngineLocator.Find(dir.Root, enginePath: "C:\\elsewhere\\adiutor-sync.js", _ => null);
        Assert.Equal(dir.File("node.exe"), found!.NodePath);

        using var dev = new TempFolder();
        var script = dev.File("adiutor-sync.js");
        File.WriteAllText(script, "");
        var bin = Path.Combine(dev.Root, "bin");
        Directory.CreateDirectory(bin);
        File.WriteAllText(Path.Combine(bin, "node.exe"), "");
        // A relative PATH entry is never searched: Windows would read it from the current folder.
        Assert.Null(EngineLocator.Find(dev.Root + "x", script, n => n == "PATH" ? "bin" : null));
        Assert.Equal(Path.Combine(bin, "node.exe"), EngineLocator.Find(dev.Root + "x", script, n => n == "PATH" ? $"bin;{bin}" : null)!.NodePath);
        Assert.Null(EngineLocator.Find(dev.Root + "x", "adiutor-sync.js", n => n == "PATH" ? bin : null));
    }

    [Theory]
    [InlineData("busy", "busy")]
    [InlineData("server_older", "server_older")]
    [InlineData("Some Message with a Name", "other")]
    [InlineData("", "other")]
    public void Only_short_codes_reach_the_log(string code, string logged) => Assert.Equal(logged, NodeEngine.SafeCode(code));
}
