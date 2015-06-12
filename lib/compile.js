var _ = require('lodash');
var chalk = require('chalk');
var map = require('map-stream');
var moment = require('moment');
var mutil = require('miaow-util');
var vinylFs = require('vinyl-fs');

var Cache = require('./cache');
var Module = require('./module');
var config = require('./config');

moment.locale('zh-cn');

/**
 * 编译主入口
 *
 * @param {Object} options 编译选项
 * @param {Function} cb 回调函数
 */
function compile(options, cb) {
  options = _.extend({}, config, options || {});

  var cache = new Cache(options);

  var globs = ['./**/*'].concat(_.map(options.exclude || [], function (item) {
    return '!' + item;
  }));

  var startTime = new Date().getTime();
  mutil.log('开始编译...');

  var task = vinylFs
    .src(globs, {cwd: options.cwd})
    .pipe(map(function (file, cb) {
      if (file.isDirectory() || file.isStream() || file.isNull()) {
        return cb();
      }

      if (cache.modules[file.relative]) {
        return cb(cache.modules[file.relative]);
      }

      var module = new Module(file, options, cache);

      module.compile(function (err) {
        cb(err, module);
      });

      cache.add(module);
    }));

  task.once('error', cb);

  task.once('end', function (err) {
    if (err) {
      return complete(err);
    }
    mutil.execPlugins(cache.modules, options.pack || [], complete);
  });

  function complete(err) {
    if (err) {
      return cb(err);
    }

    var endTime = new Date().getTime();
    mutil.log(
      '成功编译 ' +
      chalk.green.underline.bold(_.size(cache.modules)) +
      ' 个模块，耗时 ' +
      chalk.green.underline.bold(moment.duration(endTime - startTime).humanize())
    );

    cache.serialize(cb);
  }
}

module.exports = compile;