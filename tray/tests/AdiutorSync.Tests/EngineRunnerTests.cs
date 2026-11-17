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
    public async Task The_engine_is_in_the_job_before_it_runs_any_code()
    {
        using var job = new EngineJob();
        var engine = new NodeEngine(Location(), job, NoLog.Instance);
        var threadsWhileStalled = 0;
        var inJobWhileSuspended = true;
        // A stall between creating the engine and putting it in the job: the engine must not run meanwhile. A started
        // node.exe has many threads within a second; a suspended one has only its first.
        engine.BeforeResume = pid =>
        {
            Thread.Sleep(1500);
            using var process = Process.GetProcessById(pid);
            threadsWhileStalled = process.Threads.Count;
            inJobWhileSuspended = job.Contains(pid);
        };
        var childPid = new TaskCompletionSource<int>();
        var run = engine.RunAsync(
            new EngineCommand(["spawn"], TimeSpan.FromSeconds(20), OnEvent: e =>
            {
                if (e is MessageEvent m && int.TryParse(m.Text, out var pid))
                    childPid.TrySetResult(pid);
            }),
            TestContext.Current.CancellationToken);
        var child = await childPid.Task.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        Assert.Equal(1, threadsWhileStalled);
        // Created in the job (PROC_THREAD_ATTRIBUTE_JOB_LIST): in it before it ran anything.
        Assert.True(inJobWhileSuspended);
        Assert.True(job.Contains(child), "the engine's child is outside the job");
        var outcome = await run.WaitAsync(TimeSpan.FromSeconds(60), TestContext.Current.CancellationToken);
        Assert.Equal("timeout", outcome.Failure);
    }

    [Fact]
    public async Task The_output_ends_when_the_engine_ended_though_a_child_holds_it_open()
    {
        using var job = new EngineJob();
        var engine = new NodeEngine(Location(), job, NoLog.Instance);
        var leaked = 0;
        var watch = Stopwatch.StartNew();
        var outcome = await engine.RunAsync(new EngineCommand(["leak"], TimeSpan.FromSeconds(60), OnEvent: e =>
        {
            if (e is MessageEvent m && int.TryParse(m.Text, out var pid))
                leaked = pid;
        }), TestContext.Current.CancellationToken);
        // The child holds the pipe for 30 seconds; the command ends soon after the engine did.
        Assert.True(outcome.Result?.Ok, outcome.Failure);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(15), $"took {watch.Elapsed}");
        // The command's own job ended the child it left.
        Assert.NotEqual(0, leaked);
        await WaitGone(leaked);
    }

    [Fact]
    public async Task A_process_started_meanwhile_with_inherited_handles_does_not_hold_up_a_command()
    {
        using var job = new EngineJob();
        var engine = new NodeEngine(Location(), job, NoLog.Instance);
        var node = Location().NodePath;
        var others = new List<Process>();
        using var stop = new CancellationTokenSource();
        // As Velopack's Process.Start does: a child that inherits every inheritable handle of the tray.
        var starter = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                var info = new ProcessStartInfo(node, ["-e", "setTimeout(() => {}, 20000)"]) { RedirectStandardInput = true, UseShellExecute = false, CreateNoWindow = true };
                lock (others)
                    others.Add(Process.Start(info)!);
                await Task.Delay(20);
            }
        }, TestContext.Current.CancellationToken);
        try
        {
            for (var i = 0; i < 8; i++)
            {
                var watch = Stopwatch.StartNew();
                var outcome = await engine.RunAsync(new EngineCommand(["status"], TimeSpan.FromSeconds(60)), TestContext.Current.CancellationToken);
                Assert.True(outcome.Result?.Ok, outcome.Failure);
                Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10), $"took {watch.Elapsed}");
            }
        }
        finally
        {
            await stop.CancelAsync();
            await starter;
            lock (others)
            {
                foreach (var p in others)
                {
                    try
                    {
                        p.Kill();
                    }
                    catch (InvalidOperationException)
                    {
                    }
                    p.Dispose();
                }
            }
        }
    }

    [Fact]
    public async Task A_process_created_and_not_handed_back_is_ended()
    {
        using var job = new EngineJob();
        var engine = new NodeEngine(Location(), job, NoLog.Instance);
        Process? created = null;
        engine.BeforeResume = pid =>
        {
            created = Process.GetProcessById(pid);
            throw new InvalidOperationException("a failure after the process was created");
        };
        var outcome = await engine.RunAsync(new EngineCommand(["status"], TimeSpan.FromSeconds(30)), TestContext.Current.CancellationToken);
        Assert.Equal("start_failed", outcome.Failure);
        Assert.NotNull(created);
        Assert.True(created!.WaitForExit(TimeSpan.FromSeconds(10)), "the created process was left alive");
        created.Dispose();
    }

    [Fact]
    public async Task Nothing_starts_once_the_tray_job_closed()
    {
        var job = new EngineJob();
        var engine = new NodeEngine(Location(), job, NoLog.Instance);
        job.Dispose();
        var outcome = await engine.RunAsync(new EngineCommand(["status"], TimeSpan.FromSeconds(30)), TestContext.Current.CancellationToken);
        Assert.Equal("start_failed", outcome.Failure);
    }

    private static async Task WaitGone(int pid)
    {
        for (var i = 0; i < 100; i++)
        {
            try
            {
                using var p = Process.GetProcessById(pid);
                if (p.HasExited)
                    return;
            }
            catch (ArgumentException)
            {
                return;
            }
            await Task.Delay(100);
        }
        Assert.Fail($"process {pid} outlived its command");
    }

    [Theory]
    [InlineData("plain", "plain")]
    [InlineData("a b", "\"a b\"")]
    [InlineData("say \"hi\"", "\"say \\\"hi\\\"\"")]
    [InlineData(@"C:\dir\", @"C:\dir\")]
    [InlineData(@"C:\a dir\", "\"C:\\a dir\\\\\"")]
    [InlineData("", "\"\"")]
    public void Arguments_are_quoted_as_the_C_runtime_reads_them(string arg, string quoted)
    {
        var line = new System.Text.StringBuilder();
        JobProcess.AppendArgument(line, arg);
        Assert.Equal(quoted, line.ToString());
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
