var _ = require('lodash');
var Q = require('q');
var util = require('util');
var destroy = require('destroy');
var GitHub = require('octocat');
var request = require('request');
var Buffer = require('buffer').Buffer;
var githubWebhook = require('github-webhook-handler');

var Backend = require('./backend');

function GitHubBackend() {
    var that = this;
    Backend.apply(this, arguments);

    this.client = new GitHub({
        token: this.opts.token,
        username: this.opts.username,
        password: this.opts.password
    });

    this.ghrepo = this.client.repo(this.opts.repository);
    this.releases = this.memoize(this._releases);

    // GitHub webhook to refresh list of versions
    this.webhookHandler = githubWebhook({
        path: '/refresh',
        secret: this.opts.refreshSecret
    });

    // Webhook from GitHub
    this.webhookHandler.on('release', function(event) {
        that.onRelease();
        that.versions.list();
    });
    this.nuts.router.use(this.webhookHandler);
}
util.inherits(GitHubBackend, Backend);

// List all releases for this repository
GitHubBackend.prototype._releases = function() {
    return this.ghrepo.releases()
    .then(function(page) {
        return page.all();
    });
};

// Return stream for an asset
GitHubBackend.prototype.getAssetStream = function(asset) {
    var headers = {
        'User-Agent': 'nuts',
        'Accept': 'application/octet-stream'
    };
    var httpAuth;

    if (this.opts.token) {
        headers['Authorization'] = 'token '+this.opts.token;
    } else if (this.opts.username) {
        httpAuth = {
            user: this.opts.username,
            pass: this.opts.password,
            sendImmediately: true
        };
    }

    return Q(request({
        uri: asset.raw.url,
        method: 'get',
        headers: headers,
        auth: httpAuth
    }));
};


module.exports = GitHubBackend;
