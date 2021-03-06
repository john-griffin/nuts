var _ = require('lodash');
var Q = require('q');
var url = require('url');
var os = require('os');
var path = require('path');
var Understudy = require('understudy');
var LRU = require('lru-diskcache');
var express = require('express');
var useragent = require('express-useragent');

var BACKENDS = require('./backends');
var Versions = require('./versions');
var notes = require('./utils/notes');
var platforms = require('./utils/platforms');
var winReleases = require('./utils/win-releases');
var API_METHODS = require('./api');

function getFullUrl(req) {
    return req.protocol + '://' + req.get('host') + req.originalUrl;
}

function Nuts(opts) {
    if (!(this instanceof Nuts)) return new Nuts(opts);
    var that = this;

    Understudy.call(this);
    _.bindAll(this);

    this.opts = _.defaults(opts || {}, {
        // Backend to use
        backend: 'github',

        // Timeout for releases cache (seconds)
        timeout: 60*60*1000,

        // Folder to cache assets
        cache: path.resolve(os.tmpdir(), 'nuts'),

        // Cache configuration
        cacheMax: 500 * 1024 * 1024,
        cacheMaxAge: 60 * 60 * 1000,

        // Pre-fetch list of releases at startup
        preFetch: true,

        // Secret for GitHub webhook
        refreshSecret: 'secret',

        // Middlewares
        onDownload: function(version, req, next) { next(); },
        onAPIAccess: function(req, res, next) { next(); }
    });

    // Create router
    this.router = express.Router();

    // Create cache
    this.cache = LRU(opts.cache, {
        max: opts.cacheMax,
        maxAge: opts.cacheMaxAge
    });

    // Create backend
    this.backend = new (BACKENDS(this.opts.backend))(this, this.opts);
    this.versions = new Versions(this.backend);

    // Bind routes
    this.router.use(useragent.express());

    this.router.get('/', this.onDownload);
    this.router.get('/download/channel/:channel/:platform?', this.onDownload);
    this.router.get('/download/version/:tag/:platform?', this.onDownload);
    this.router.get('/download/:tag/:filename', this.onDownload);
    this.router.get('/download/:platform?', this.onDownload);

    this.router.get('/update', this.onUpdate);
    this.router.get('/update/:platform/:version', this.onUpdateOSX);
    this.router.get('/update/:platform/:version/RELEASES', this.onUpdateWin);

    this.router.get('/notes/:version?', this.onServeNotes);

    // Bind API
    this.router.use('/api', this.onAPIAccessControl);
    _.each(API_METHODS, function(method, route) {
        this.router.get('/api/' + route, function(req, res, next) {
            return Q()
            .then(function() {
                return method.call(that, req);
            })
            .then(function(result) {
                res.send(result);
            }, next);
        });
    }, this);
}

// Prepare nuts
Nuts.prototype.init = function() {
    var that = this;
    this.cache.init();

    return Q()
    .then(function() {
        return that.backend.init();
    })
    .then(function() {
        if (!that.opts.preFetch) return
        return that.versions.list();
    });
};

// Perform a hook using promised functions
Nuts.prototype.performQ = function(name, arg, fn) {
    var that = this;
    fn = fn || function() { };

    return Q.nfcall(this.perform, name, arg, function (next) {
        Q()
        .then(function() {
            return fn.call(that, arg);
        })
        .then(function() {
            next();
        }, next);
    })
};

// Serve an asset to the response
Nuts.prototype.serveAsset = function(req, res, version, asset) {
    var that = this;
    var cacheKey = asset.id;

    function outputStream(stream) {
        stream.pipe(res);
    }

    return this.performQ('download', {
        req: req,
        version: version,
        platform: asset
    }, function() {
        var d = Q.defer();
        res.header('Content-Length', asset.size);
        res.attachment(asset.filename);

        // Key exists
        if (that.cache.has(cacheKey)) {
            return that.cache.getStream(cacheKey)
                .then(outputStream);
        }

        return that.backend.getAssetStream(asset)
        .then(function(stream) {
            return Q.all([
                // Cache the stream
                that.cache.set(cacheKey, stream),

                // Send the stream to the user
                outputStream(stream)
            ]);
        });
    });
};

// Handler for download routes
Nuts.prototype.onDownload = function(req, res, next) {
    var that = this;
    var channel = req.params.channel;
    var platform = req.params.platform;
    var tag = req.params.tag || 'latest';
    var filename = req.params.filename;
    var filetypeWanted = req.query.filetype;

    // When serving a specific file, platform is not required
    if (!filename) {
        // Detect platform from useragent
        if (!platform) {
            if (req.useragent.isMac) platform = platforms.OSX;
            if (req.useragent.isWindows) platform = platforms.WINDOWS;
            if (req.useragent.isLinux) platform = platforms.LINUX;
            if (req.useragent.isLinux64) platform = platforms.LINUX_64;
        }

        if (!platform) return next(new Error('No platform specified and impossible to detect one'));
    } else {
        platform = null;
    }

    // If specific version, don't enforce a channel
    if (tag != 'latest') channel = '*';

    this.versions.resolve({
        channel: channel,
        platform: platform,
        tag: tag
    })

    // Fallback to any channels if no version found on stable one
    .fail(function(err) {
        if (channel || tag != 'latest') throw err;

        return versions.resolve({
            channel: '*',
            platform: platform,
            tag: tag
        });
    })

    // Serve downloads
    .then(function(version) {
        var asset;

        if (filename) {
            asset = _.find(version.platforms, {
                filename: filename
            });
        } else {
            asset = platforms.resolve(version, platform, {
                wanted: filetypeWanted? '.'+filetypeWanted : null
            });
        }

        if (!asset) throw new Error("No download available for platform "+platform+" for version "+version.tag+" ("+(channel || "beta")+")");

        // Call analytic middleware, then serve
        return that.serveAsset(req, res, version, asset);
    })
    .fail(next);
};


// Request to update
Nuts.prototype.onUpdate = function(req, res, next) {
    Q()
    .then(function() {
        if (!req.query.version) throw new Error('Requires "version" parameter');
        if (!req.query.platform) throw new Error('Requires "platform" parameter');

        return res.redirect('/update/'+req.query.platform+'/'+req.query.version);
    })
    .fail(next);
};

// Updater OSX (Squirrel.Mac)
Nuts.prototype.onUpdateOSX = function(req, res, next) {
    var that = this;
    var fullUrl = getFullUrl(req);
    var platform = req.params.platform;
    var tag = req.params.version;

    Q()
    .then(function() {
        if (!tag) throw new Error('Requires "version" parameter');
        if (!platform) throw new Error('Requires "platform" parameter');

        platform = platforms.detect(platform);

        return that.versions.filter({
            tag: '>='+tag,
            platform: platform,
            channel: '*'
        });
    })
    .then(function(versions) {
        var latest = _.first(versions);
        if (!latest || latest.tag == tag) return res.status(204).send('No updates');

        var releaseNotes = notes.merge(versions.slice(0, -1), { includeTag: false });

        res.status(200).send({
            "url": url.resolve(fullUrl, "/download/version/"+latest.tag+"/"+platform+"?filetype=zip"),
            "name": latest.tag,
            "notes": releaseNotes,
            "pub_date": latest.published_at.toISOString()
        });
    })
    .fail(next);
};

// Update Windows (Squirrel.Windows)
// Auto-updates: Squirrel.Windows: serve RELEASES from latest version
// Currently, it will only serve a full.nupkg of the latest release with a normalized filename (for pre-release)
Nuts.prototype.onUpdateWin = function(req, res, next) {
    var that = this;

    var fullUrl = getFullUrl(req);
    var platform = 'win_32';
    var tag = req.params.version;

    Q()
    .then(function() {
        platform = platforms.detect(platform);

        return that.versions.filter({
            tag: '>='+tag,
            platform: platform,
            channel: '*'
        });
    })
    .then(function(versions) {
        // Update needed?
        var latest = _.first(versions);
        if (!latest) throw new Error("Version not found");

        // File exists
        var asset = _.find(latest.platforms, {
            filename: 'RELEASES'
        });
        if (!asset) throw new Error("File not found");

       return that.backend.readAsset(asset)
       .then(function(content) {
            var releases = winReleases.parse(content.toString('utf-8'));

            releases = _.chain(releases)

                // Change filename to use download proxy
                .map(function(entry) {
                    entry.filename = url.resolve(fullUrl, '/download/'+entry.semver+'/'+entry.filename);

                    return entry;
                })

                .value();

            var output = winReleases.generate(releases);

            res.header('Content-Length', output.length);
            res.attachment("RELEASES");
            res.send(output);
       });
    })
    .fail(next);
};

// Serve releases notes
Nuts.prototype.onServeNotes = function(req, res, next) {
    var that = this;
    var tag = req.params.version;

    Q()
    .then(function() {
        return that.versions.filter({
            tag: tag? '>='+tag : '*',
            channel: '*'
        });
    })
    .then(function(versions) {
        var latest = _.first(versions);

        if (!latest) throw new Error('No versions matching');

        res.format({
            'text/plain': function(){
                res.send(notes.merge(versions));
            },
            'application/json': function(){
                res.send({
                    "notes": notes.merge(versions, { includeTag: false }),
                    "pub_date": latest.published_at.toISOString()
                });
            },
            'default': function() {
                res.send(releaseNotes);
            }
        });
    })
    .fail(next);
};

// Control access to the API
Nuts.prototype.onAPIAccessControl = function(req, res, next) {
    this.performQ('api', {
        req: req,
        res: res
    })
    .then(function() {
        next();
    }, next);
};


module.exports = Nuts;
