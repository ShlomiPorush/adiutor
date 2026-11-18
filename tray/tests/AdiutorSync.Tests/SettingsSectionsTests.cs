using AdiutorSync.Core;

namespace AdiutorSync.Tests;

// The settings window's areas: closed by default, open on their own when a connection needs the owner, once.
public class SettingsSectionsTests
{
    [Theory]
    [InlineData(ConnectionState.Connected, false, false)]
    [InlineData(ConnectionState.Unknown, false, false)]
    [InlineData(null, false, false)]
    [InlineData(ConnectionState.NotConnected, false, true)]
    [InlineData(ConnectionState.Ended, false, true)]
    [InlineData(ConnectionState.Connected, true, true)]
    public void A_connection_needs_the_owner_when_it_is_missing_ended_or_not_fully_disconnected(ConnectionState? state, bool revocationPending, bool expected) =>
        Assert.Equal(expected, SettingsSections.NeedsAttention(state, revocationPending));

    [Fact]
    public void An_area_opens_once_when_it_starts_needing_the_owner()
    {
        var attention = new SectionAttention();
        Assert.False(attention.Update(false));
        Assert.True(attention.Update(true));
        // Still needed: the owner may have closed it, and it stays closed.
        Assert.False(attention.Update(true));
        Assert.False(attention.Update(false));
        // Needed again later: it opens again.
        Assert.True(attention.Update(true));
    }

    [Fact]
    public void An_area_that_needs_the_owner_when_the_window_opens_starts_open() =>
        Assert.True(new SectionAttention().Update(true));

    [Fact]
    public void The_sync_header_names_the_schedule_and_a_missing_overview_folder()
    {
        var en = Texts.Load(Texts.English);
        Assert.Equal("Sync every 4 hours", SettingsSections.SyncSummary(en, 4, @"C:\overview"));
        Assert.Equal("Sync every 1 hour \u00B7 no security data", SettingsSections.SyncSummary(en, 1, " "));
        var he = Texts.Load(Texts.Hebrew);
        Assert.Equal(he["settings.schedule"] + " " + he.Format("settings.hours", ("n", "2")) + " \u00B7 " + he["settings.noOverview"],
            SettingsSections.SyncSummary(he, 2, null));
    }
}
