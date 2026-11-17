using AdiutorSync.Core;

namespace AdiutorSync.Tests;

// The parser against the engine's output shapes (src/sync/contract.ts, docs/sync.md "Machine-readable output").
public class EngineOutputTests
{
    [Fact]
    public void Status_with_every_field()
    {
        var result = Fixture.Result("status-connected.jsonl");
        Assert.True(result.Ok);
        Assert.Equal("status", result.Command);
        var status = Assert.IsType<EngineStatus>(result.Status);
        Assert.Equal(ConnectionState.Connected, status.Adiutor.State);
        Assert.Equal("https://adiutor.example.com", status.Adiutor.Url);
        Assert.Equal(ConnectionState.Connected, status.T3.State);
        Assert.Equal(DateTimeOffset.Parse("2026-12-16T08:00:00Z", CultureInfo.InvariantCulture), status.T3.ExpiresAt);
        var last = Assert.IsType<RunReport>(status.LastRun);
        Assert.Equal(PartResult.Accepted, last.T3.Result);
        Assert.Equal(PartResult.Partial, last.Security.Result);
        Assert.Equal("repos_missing", last.Security.Reason);
        Assert.False(last.IsGood);
        Assert.Equal(DateTimeOffset.Parse("2026-11-17T03:03:00Z", CultureInfo.InvariantCulture), status.LastGoodSyncAt);
        Assert.Equal(DateTimeOffset.Parse("2026-11-17T09:00:00Z", CultureInfo.InvariantCulture), status.RunningSince);
        // Request ids are compared in lower case, as the engine keeps them.
        Assert.Equal("0d2c9b4e-6a8f-4c1e-9d3b-7a5f2e1c0b9a", status.Claim?.RequestId);
        Assert.Single(status.SettingsProblems);
    }

    [Fact]
    public void Status_of_a_new_computer()
    {
        var status = Fixture.Result("status-new.jsonl").Status!;
        Assert.Equal(ConnectionState.NotConnected, status.Adiutor.State);
        Assert.Null(status.Adiutor.Url);
        Assert.Equal(ConnectionState.Ended, status.T3.State);
        Assert.Equal("other_environment", status.T3.Reason);
        Assert.True(status.T3.RevocationPending);
        Assert.Null(status.LastRun);
        Assert.Null(status.RunningSince);
        Assert.Null(status.Claim);
    }

    [Fact]
    public void Run_report_after_events()
    {
        var lines = Fixture.Lines("run-report.jsonl").Select(EngineOutput.ParseLine).ToList();
        Assert.Equal(2, lines.OfType<MessageEvent>().Count());
        var result = lines.OfType<EngineResult>().Single();
        Assert.True(result.Ok);
        Assert.False(result.Busy);
        Assert.True(result.Report!.IsGood);
        Assert.Null(result.Report.RequestId);
    }

    [Fact]
    public void Run_busy()
    {
        var result = Fixture.Result("run-busy.jsonl");
        Assert.False(result.Ok);
        Assert.True(result.Busy);
        Assert.Equal(DateTimeOffset.Parse("2026-11-17T09:00:00Z", CultureInfo.InvariantCulture), result.BusySince);
        Assert.Equal("busy", result.Error?.Code);
        Assert.Null(result.Report);
    }

    [Fact]
    public void Run_that_failed_keeps_its_report()
    {
        var result = Fixture.Result("run-failed.jsonl");
        Assert.False(result.Ok);
        Assert.Equal(PartResult.NotRun, result.Report!.T3.Result);
        Assert.Equal(PartResult.OutcomeUnknown, result.Report.Security.Result);
        Assert.Equal("0d2c9b4e-6a8f-4c1e-9d3b-7a5f2e1c0b9a", result.Report.RequestId);
    }

    [Fact]
    public void Checkin_claim_and_older_server()
    {
        Assert.Equal("0d2c9b4e-6a8f-4c1e-9d3b-7a5f2e1c0b9a", Fixture.Result("checkin-claim.jsonl").Claim?.RequestId);
        var older = Fixture.Result("checkin-older.jsonl");
        Assert.False(older.Ok);
        Assert.Null(older.Claim);
        Assert.Equal("server_older", older.Error?.Code);
    }

    [Fact]
    public void Connect_approval_event()
    {
        var lines = Fixture.Lines("connect-approval.jsonl").Select(EngineOutput.ParseLine).ToList();
        var approval = lines.OfType<ApprovalEvent>().Single();
        Assert.Equal("ABCD-EFGH", approval.UserCode);
        Assert.StartsWith("https://adiutor.example.com/", approval.Link, StringComparison.Ordinal);
        var result = lines.OfType<EngineResult>().Single();
        Assert.Equal("connected", result.ConnectState);
    }

    [Fact]
    public void Disconnect_t3_connect_and_usage()
    {
        var disconnect = Fixture.Result("disconnect-pending.jsonl");
        Assert.True(disconnect.WasConnected);
        Assert.True(disconnect.RevocationPending);
        Assert.Equal("revocation_pending", disconnect.Error?.Code);
        Assert.True(Fixture.Result("t3-connect.jsonl").Ok);
        var usage = Fixture.Result("usage.jsonl");
        Assert.Null(usage.Command);
        Assert.Equal("usage", usage.Error?.Code);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[1,2]")]
    [InlineData("{\"type\":\"result\",\"v\":2,\"command\":\"status\",\"ok\":true}")]
    [InlineData("{\"type\":\"result\",\"v\":1,\"command\":\"run\"}")]
    [InlineData("{\"type\":\"event\",\"event\":\"approval\",\"link\":\"x\"}")]
    [InlineData("{\"type\":\"result\",\"v\":1,\"command\":\"run\",\"ok\":true,\"report\":{\"startedAt\":\"yesterday\"}}")]
    public void Lines_that_are_not_the_contract_are_skipped(string line) => Assert.Null(EngineOutput.ParseLine(line));

    [Fact]
    public void Unknown_fields_and_values_are_tolerated()
    {
        var line = """{"type":"result","v":1,"command":"run","ok":true,"future":1,"report":{"startedAt":"2026-11-17T09:00:00.000Z","finishedAt":"2026-11-17T09:01:00.000Z","dryRun":false,"requestId":null,"t3":{"result":"something_new"},"security":{"result":"accepted"},"lastGoodSyncAt":null}}""";
        var result = Assert.IsType<EngineResult>(EngineOutput.ParseLine(line));
        Assert.Equal(PartResult.Unknown, result.Report!.T3.Result);
        Assert.False(result.Report.IsGood);
    }

    [Theory]
    [InlineData(PartResult.Accepted, "accepted")]
    [InlineData(PartResult.Partial, "partial")]
    [InlineData(PartResult.Failed, "failed")]
    [InlineData(PartResult.OutcomeUnknown, "outcome_unknown")]
    [InlineData(PartResult.NotRun, "not_run")]
    [InlineData(PartResult.Unknown, "failed")]
    public void Part_names_round_trip(PartResult part, string name)
    {
        Assert.Equal(name, EngineOutput.PartName(part));
        if (part != PartResult.Unknown)
            Assert.Equal(part, EngineOutput.Part(name));
    }
}
