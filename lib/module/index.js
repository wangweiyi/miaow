var _ = require('lodash');
var async = require('async');
var File = require('vinyl');
var fs = require('fs-extra');
var mutil = require('miaow-util');
var path = require('path');
var url = require('url');

var dest = require('./dest');

/**
 * 模块
 *
 * 模块是处理文件的单元,每个文件都被抽象成模块
 *
 * @param {Vinyl} file 待处理的文件对象
 * @param {Object} options 配置信息
 * @param {Cache} cache 缓存组件
 * @constructor
 */
function Module(file, options, cache) {
  this.file = file;
  this.options = options;
  this.cache = cache;

  // 依赖的模块列表
  this.dependencies = [];

  // 获取一些模块配置
  var moduleOptions = this.moduleOptions = {};
  _.each(['road', 'parse', 'pack', 'lint', 'mini'], function (name) {
    moduleOptions[name] = getModuleOption(options, 'module.' + name, file.relative);
  });

  function getModuleOption(options, path, relativeFilePath) {
    return _.find(_.result(options, path) || [], function (option) {
        return option.test.test(relativeFilePath);
      }) || {};
  }
}

/**
 * 解析文件内容,并分析出依赖的模块列表
 *
 * @param cb
 */
Module.prototype.parse = function (cb) {
  // 如果不启用解析,就直接返回
  if (_.isEmpty(this.moduleOptions.parse || {})) {
    return cb();
  }

  this.execPlugins(this.moduleOptions.parse.plugins, cb);
};

/**
 * 校验代码
 *
 * @param cb
 */
Module.prototype.lint = function (cb) {
  // 如果不启用校验,就直接返回
  if (!this.options.lint || _.isEmpty(this.moduleOptions.lint || {})) {
    return cb();
  }

  this.execPlugins(this.moduleOptions.lint.plugins, cb);
};

/**
 * 压缩
 *
 * @param cb
 */
Module.prototype.mini = function (cb) {
  // 如果不启用压缩,就直接返回
  if (!this.options.mini || _.isEmpty(this.moduleOptions.mini || {})) {
    return cb();
  }

  // 由于压缩比较耗时,所以启用缓存
  this.cache.getMinifiedContent(this.file.relative, this.hash, function (err, contents) {
    if (err) {
      return cb(err);
    }

    if (contents) {
      this.file.contents = contents;
      return cb();
    }

    this.execPlugins(this.moduleOptions.mini.plugins, cb);
  }.bind(this));
};

/**
 * 生成文件
 *
 * @param cb
 */
Module.prototype.dest = function (cb) {
  var roadConfig = this.moduleOptions.road;
  var file = this.file;
  var destPath = this.destPath;

  // 默认生成不带hash的文件
  var writePathList = [
    path.resolve(this.options.output, destPath)
  ];

  // 判断是否生成带有hash的文件
  if (this.useHash) {
    writePathList.push(
      writePathList[0].replace(/\.[^\.]+$/, function (ext) {
        return '_' + this.hash.slice(0, this.options.hash) + ext;
      }.bind(this))
    );
  }

  // 设置编码
  var encoding = roadConfig.encoding || 'utf8';
  // 生成文件
  async.each(writePathList, function (writePath, cb) {
    dest(writePath, file, encoding, cb);
  }, cb);
};

Module.prototype.compile = function (cb) {
  async.eachSeries([
    'parse',
    'lint',
    'mini',
    'dest'
  ], function (task, cb) {
    this[task](cb);
  }.bind(this), function (err) {
    if (err) {
      return cb(err);
    }

    this.done = true;
    cb();
  }.bind(this));
};

/**
 * 获取对应路径的已编译好的模块
 *
 * @param {String} relative 相对路径
 * @param {Function} cb
 */
Module.prototype.getModule = function (relative, cb) {
  var srcPath = mutil.resolve(
    relative,
    path.dirname(this.file.path),
    this.options.resolve
  );

  srcPath = path.relative(this.options.cwd, srcPath);

  this.cache.get(srcPath, function (err, module) {
    if (err) {
      return cb(err);
    }

    if (module) {
      // 如果模块还没有编译完成,就可以认定为被循环依赖
      if (!module.done) {
        return cb(new Error(srcPath + '被循环依赖了'));
      } else {
        return cb(null, module);
      }
    }

    var cwd = this.options.cwd;
    var absPath = path.join(cwd, srcPath);
    fs.readFile(absPath, function (err, data) {
      if (err) {
        return cb(err);
      }

      var file = new File({
        cwd: cwd,
        base: cwd,
        path: absPath,
        stat: fs.statSync(absPath),
        contents: data
      });

      module = new Module(file, this.options, this.cache);
      module.compile(function (err) {
        if (err) {
          return cb(err);
        }

        cb(null, module);
      });
    }.bind(this));
  }.bind(this));
};

/**
 * 运行插件
 *
 * @param {Array|Object|Function|String} plugins
 * @param {Function} cb
 */
Module.prototype.execPlugins = function (plugins, cb) {
  mutil.execPlugins(this, plugins, cb);
};

// 生成目标的相对路径
Object.defineProperty(Module.prototype, 'destPath', {
  get: function () {
    if (this._destPath) {
      return this._destPath;
    }
    var roadConfig = this.moduleOptions.road;
    var destPath = this.srcPath;

    // 判断是否修改生成文件的相对路径
    if (roadConfig.release) {
      destPath = destPath.replace(roadConfig.test, roadConfig.release);
    }

    this._destPath = destPath;

    return destPath;
  }
});

// 源目录的相对路径
Object.defineProperty(Module.prototype, 'srcPath', {
  get: function () {
    return this.file.relative;
  }
});

// 是否启用hash
Object.defineProperty(Module.prototype, 'useHash', {
  get: function () {
    var roadConfig = this.moduleOptions.road;
    return this.options.hash && (_.isUndefined(roadConfig.useHash) || roadConfig.useHash);
  }
});

// hash值,最好是在parse修改完内容后获取
Object.defineProperty(Module.prototype, 'hash', {
  get: function () {
    this._hash = this._hash || mutil.hash(this.file.contents);
    return this._hash;
  }
});

Object.defineProperty(Module.prototype, 'url', {
  get: function () {
    var roadConfig = this.moduleOptions.road;
    var domain = roadConfig.domain || this.options.domain;

    if (!domain || this.options.domain === false) {
      return null;
    }

    var destPath = this.destPath;

    var fileName = path.basename(destPath);
    // 追加hash版本号
    if (this.useHash) {
      fileName = fileName.replace(/\.[^\.]+$/, function (ext) {
        return '_' + this.hash.slice(0, this.options.hash) + ext;
      }.bind(this));
    }

    return url.resolve(domain, path.join(path.dirname(destPath), fileName));
  }
});

module.exports = Module;