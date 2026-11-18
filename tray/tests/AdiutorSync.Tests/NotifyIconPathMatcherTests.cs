using AdiutorSync.Core;

namespace AdiutorSync.Tests;

public sealed class NotifyIconPathMatcherTests
{
    private const string ProcessPath = @"C:\Users\owner\AppData\Local\AdiutorSync\current\AdiutorSync.exe";
    private static readonly Guid LocalAppData = Guid.Parse("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");
    private static readonly Guid ProgramFiles = Guid.Parse("6D809377-6AF0-444B-8957-A3773F02200E");

    private static string? Resolve(Guid id) =>
        id == LocalAppData ? @"C:\Users\owner\AppData\Local"
        : id == ProgramFiles ? @"C:\Program Files"
        : null;

    private static string? ResolveNothing(Guid id) => null;

    [Theory]
    [InlineData(@"C:\Users\owner\AppData\Local\AdiutorSync\current\AdiutorSync.exe")]
    [InlineData(@"c:\users\OWNER\appdata\local\adiutorsync\current\adiutorsync.EXE")]
    [InlineData(@"C:/Users/owner/AppData/Local/AdiutorSync/current/AdiutorSync.exe")]
    [InlineData(@"""C:\Users\owner\AppData\Local\AdiutorSync\current\AdiutorSync.exe""")]
    public void A_plain_path_matches_in_any_case(string stored) =>
        Assert.True(NotifyIconPathMatcher.Matches(stored, ProcessPath, Resolve));

    [Fact]
    public void A_known_folder_prefix_is_resolved()
    {
        Assert.True(NotifyIconPathMatcher.Matches(
            @"{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}\AdiutorSync\current\AdiutorSync.exe", ProcessPath, Resolve));
        Assert.True(NotifyIconPathMatcher.Matches(
            @"{6d809377-6af0-444b-8957-a3773f02200e}\AdiutorSync\AdiutorSync.exe", @"C:\Program Files\AdiutorSync\AdiutorSync.exe", Resolve));
    }

    [Fact]
    public void A_resolved_known_folder_must_match_the_whole_path() =>
        Assert.False(NotifyIconPathMatcher.Matches(
            @"{6D809377-6AF0-444B-8957-A3773F02200E}\AdiutorSync\current\AdiutorSync.exe", ProcessPath, Resolve));

    [Theory]
    [InlineData(@"{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}\AdiutorSync\current\AdiutorSync.exe")]
    [InlineData(@"{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}\AdiutorSync.exe")]
    public void A_folder_that_cannot_be_resolved_never_matches(string stored) =>
        Assert.False(NotifyIconPathMatcher.Matches(stored, ProcessPath, ResolveNothing));

    [Fact]
    public void A_resolver_that_throws_never_matches() =>
        Assert.False(NotifyIconPathMatcher.Matches(
            @"{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}\AdiutorSync\current\AdiutorSync.exe", ProcessPath,
            _ => throw new InvalidOperationException()));

    [Theory]
    [InlineData(@"C:\Program Files\Other\Other.exe")]
    [InlineData(@"C:\Users\owner\AppData\Local\AdiutorSync\app-0.3.0\AdiutorSync.exe")]
    [InlineData(@"T:\test\profile\AppData\Local\AdiutorSync\current\AdiutorSync.exe")]
    [InlineData(@"{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}\Other\current\Other.exe")]
    [InlineData(@"{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}")]
    [InlineData(@"{not-a-guid}\AdiutorSync\current\AdiutorSync.exe")]
    [InlineData("")]
    [InlineData(null)]
    public void Other_paths_do_not_match(string? stored) =>
        Assert.False(NotifyIconPathMatcher.Matches(stored, ProcessPath, Resolve));

    [Fact]
    public void No_process_path_never_matches() =>
        Assert.False(NotifyIconPathMatcher.Matches(ProcessPath, null, Resolve));
}
