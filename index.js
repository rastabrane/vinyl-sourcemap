'use strict';

var path = require('path');
var File = require('vinyl');
var convert = require('convert-source-map');
var stripBom = require('strip-bom');
var acorn = require('acorn');
var SourceMapGenerator = require('source-map').SourceMapGenerator;
var css = require('css');
var fs = require('graceful-fs');
var detectNewline = require('detect-newline');

var PLUGIN_NAME = 'vinyl-sourcemap';
var urlRegex = /^(https?|webpack(-[^:]+)?):\/\//;

function unixStylePath (filePath) {
	return filePath.split(path.sep).join('/');
}

/**
 * Add a sourcemap to a vinyl file (async, with callback function)
 * @param file
 * @param options
 * @param cb
 */
module.exports.add = function add (file, options, cb) {

	// check if options are passed or a callback as second argument
	// if there are 3 arguments, the options param should be an object
	if (typeof options === 'function') {
		cb = options;
		options = {};
	} else if (!options || typeof options !== 'object') {
		return cb(new Error(PLUGIN_NAME + '-add: Invalid argument: options'));
	}

	// Throw an error if the file argument is not a vinyl file
	if (!File.isVinyl(file)) {
		return cb(new Error(PLUGIN_NAME + '-add: Not a vinyl file'));
	}

	// Return the file if already has sourcemaps
	if (file.sourceMap) {
		return cb(null, file);
	}

	var fileContent = file.contents.toString();
	var sourceMap;

	if (options.loadMaps) {
		var sourcePath = ''; //root path for the sources in the map

		// Try to read inline source map
		sourceMap = convert.fromSource(fileContent);

		if (sourceMap) {
			sourceMap = sourceMap.toObject();
			// sources in map are relative to the source file
			sourcePath = path.dirname(file.path);
			fileContent = convert.removeComments(fileContent);
		} else {
			// look for source map comment referencing a source map file
			var mapComment = convert.mapFileCommentRegex.exec(fileContent);

			var mapFile;
			if (mapComment) {
				mapFile = path.resolve(path.dirname(file.path), mapComment[1] || mapComment[2]);
				fileContent = convert.removeMapFileComments(fileContent);
				// if no comment try map file with same name as source file
			} else {
				mapFile = file.path + '.map';
			}

			// sources in external map are relative to map file
			sourcePath = path.dirname(mapFile);

			try {
				sourceMap = JSON.parse(stripBom(fs.readFileSync(mapFile, 'utf8')));
			} catch (e) {}
		}

		// fix source paths and sourceContent for imported source map
		if (sourceMap) {
			sourceMap.sourcesContent = sourceMap.sourcesContent || [];
			sourceMap.sources.forEach(function(source, i) {
				if (source.match(urlRegex)) {
					sourceMap.sourcesContent[i] = sourceMap.sourcesContent[i] || null;
					return;
				}
				var absPath = path.resolve(sourcePath, source);
				sourceMap.sources[i] = unixStylePath(path.relative(file.base, absPath));

				if (!sourceMap.sourcesContent[i]) {
					var sourceContent = null;
					if (sourceMap.sourceRoot) {
						if (sourceMap.sourceRoot.match(urlRegex)) {
							sourceMap.sourcesContent[i] = null;
							return;
						}
						absPath = path.resolve(sourcePath, sourceMap.sourceRoot, source);
					}

					// if current file: use content
					if (absPath === file.path) {
						sourceContent = fileContent;

						// else load content from file
					} else {

						try {
							if (options.debug) {
								console.log(PLUGIN_NAME + '-add: No source content for "' + source + '". Loading from file.');
							}
							sourceContent = stripBom(fs.readFileSync(absPath, 'utf8'));
						} catch (e) {
							if (options.debug) {
								console.warn(PLUGIN_NAME + '-add: source file not found: ' + absPath);
							}
						}
					}
					sourceMap.sourcesContent[i] = sourceContent;
				}
			});

			// remove source map comment from source
			file.contents = new Buffer(fileContent, 'utf8');
		}
	}

	if (!sourceMap && options.identityMap) {
		var fileType = path.extname(file.path);
		var source = unixStylePath(file.relative);
		var generator = new SourceMapGenerator({ file: source });
		if (fileType === '.js') {
			var tokenizer = acorn.tokenizer(fileContent, { locations: true });
			while (true) {
				var token = tokenizer.getToken();

				if (token.type.label === 'eof') {
					break;
				}
				var mapping = {
					original: token.loc.start,
					generated: token.loc.start,
					source: source,
				};
				if (token.type.label === 'name') {
					mapping.name = token.value;
				}
				generator.addMapping(mapping);
			}
			generator.setSourceContent(source, fileContent);
			sourceMap = generator.toJSON();
		} else if (fileType === '.css') {
			var ast = css.parse(fileContent, { silent: true });
			var registerTokens = function (ast) {
				if (ast.position) {
					generator.addMapping({
						original: ast.position.start,
						generated: ast.position.start,
						source: source,
					});
				}
				for (var key in ast) {
					if (key !== 'position') {
						if (Object.prototype.toString.call(ast[key]) === '[object Object]') {
							registerTokens(ast[key]);
						} else if (ast[key].constructor === Array) {
							for (var i = 0; i < ast[key].length; i++) {
								registerTokens(ast[key][i]);
							}
						}
					}
				}
			};
			registerTokens(ast);
			generator.setSourceContent(source, fileContent);
			sourceMap = generator.toJSON();
		}
	}

	if (!sourceMap) {
		sourceMap = {
			version: 3,
			names: [],
			mappings: '',
			sources: [unixStylePath(file.relative)],
			sourcesContent: [fileContent]
		};
	}

	sourceMap.file = unixStylePath(file.relative);
	file.sourceMap = sourceMap;

	cb(null, file);

};

/**
 * Write the sourcemap (async, with callback function)
 * @param file
 * @param destPath
 * @param options
 * @param cb
 */
module.exports.write = function write (file, destPath, options, cb) {

	// Check arguments for optional destPath, options, or callback function
	if (cb === undefined && typeof destPath === 'function') {
		cb = destPath;
		destPath = undefined;
	}	else if (cb === undefined && typeof options === 'function') {
		cb = options;
		if (Object.prototype.toString.call(destPath) === '[object Object]') {
			options = destPath;
			destPath = undefined;
		} else if (typeof destPath === 'string') {
			options = {};
		} else {
			return cb(new Error(PLUGIN_NAME + '-write: Invalid arguments'));
		}
	} else if (Object.prototype.toString.call(options) !== '[object Object]') {
		return cb(new Error(PLUGIN_NAME + '-write: Invalid argument: options'));
	}

	options = options || {};

	// Throw an error if the file argument is not a vinyl file
	if (!File.isVinyl(file)) {
		return cb(new Error(PLUGIN_NAME + '-write: Not a vinyl file'));
	}

	// return array with file & optionally sourcemap file
	var arr = [];

	// set defaults for options if unset
	if (options.includeContent === undefined) {
		options.includeContent = true;
	}
	if (options.addComment === undefined) {
		options.addComment = true;
	}
	if (options.charset === undefined) {
		options.charset = 'utf8';
	}

	var sourceMap = file.sourceMap;

	// Throw an error if the file doesn't have a sourcemap
	if (!file.sourceMap) {
		return cb(new Error(PLUGIN_NAME + '-write: No sourcemap found'));
	}

	// fix paths if Windows style paths
	sourceMap.file = unixStylePath(file.relative);

	if (options.mapSources && typeof options.mapSources === 'function') {
		sourceMap.sources = sourceMap.sources.map(function(filePath) {
			return options.mapSources(filePath);
		});
	}

	sourceMap.sources = sourceMap.sources.map(function(filePath) {
		return unixStylePath(filePath);
	});

	if (typeof options.sourceRoot === 'function') {
		sourceMap.sourceRoot = options.sourceRoot(file);
	} else {
		sourceMap.sourceRoot = options.sourceRoot;
	}
	if (sourceMap.sourceRoot === null) {
		sourceMap.sourceRoot = undefined;
	}

	if (options.includeContent) {
		sourceMap.sourcesContent = sourceMap.sourcesContent || [];

		// load missing source content
		for (var i = 0; i < file.sourceMap.sources.length; i++) {
			if (!sourceMap.sourcesContent[i]) {
				var sourcePath = path.resolve(sourceMap.sourceRoot || file.base, sourceMap.sources[i]);
				try {
					if (options.debug) {
						console.log(PLUGIN_NAME + '-write: No source content for "' + sourceMap.sources[i] + '". Loading from file.');
					}
					sourceMap.sourcesContent[i] = stripBom(fs.readFileSync(sourcePath, 'utf8'));
				} catch (e) {
					if (options.debug) {
						console.warn(PLUGIN_NAME + '-write: source file not found: ' + sourcePath);
					}
				}
			}
		}
	} else {
		delete sourceMap.sourcesContent;
	}

	var extension = file.relative.split('.').pop();
	var newline = detectNewline(file.contents.toString());
	var commentFormatter;

	switch (extension) {
		case 'css':
			commentFormatter = function(url) {
				return newline + '/*# sourceMappingURL=' + url + ' */' + newline;
			};
			break;
		case 'js':
			commentFormatter = function(url) {
				return newline + '//# sourceMappingURL=' + url + newline;
			};
			break;
		default:
			commentFormatter = function() {
				return '';
			};
	}

	var comment;
	if (destPath === undefined || destPath === null) {
		// encode source map into comment
		var base64Map = new Buffer(JSON.stringify(sourceMap)).toString('base64');
		comment = commentFormatter('data:application/json;charset=' + options.charset + ';base64,' + base64Map);
	} else {
		var mapFile = path.join(destPath, file.relative) + '.map';
		// custom map file name
		if (options.mapFile && typeof options.mapFile === 'function') {
			mapFile = options.mapFile(mapFile);
		}

		var sourceMapPath = path.join(file.base, mapFile);

		// if explicit destination path is set
		if (options.destPath) {
			var destSourceMapPath = path.join(file.cwd, options.destPath, mapFile);
			var destFilePath = path.join(file.cwd, options.destPath, file.relative);
			sourceMap.file = unixStylePath(path.relative(path.dirname(destSourceMapPath), destFilePath));
			if (sourceMap.sourceRoot === undefined) {
				sourceMap.sourceRoot = unixStylePath(path.relative(path.dirname(destSourceMapPath), file.base));
			} else if (sourceMap.sourceRoot === '' || (sourceMap.sourceRoot && sourceMap.sourceRoot[0] === '.')) {
				sourceMap.sourceRoot = unixStylePath(path.join(path.relative(path.dirname(destSourceMapPath), file.base), sourceMap.sourceRoot));
			}
		} else {
			// best effort, can be incorrect if options.destPath not set
			sourceMap.file = unixStylePath(path.relative(path.dirname(sourceMapPath), file.path));
			if (sourceMap.sourceRoot === '' || (sourceMap.sourceRoot && sourceMap.sourceRoot[0] === '.')) {
				sourceMap.sourceRoot = unixStylePath(path.join(path.relative(path.dirname(sourceMapPath), file.base), sourceMap.sourceRoot));
			}
		}

		// add new source map file to stream
		var sourceMapFile = new File({
			cwd: file.cwd,
			base: file.base,
			path: sourceMapPath,
			contents: new Buffer(JSON.stringify(sourceMap)),
			stat: {
				isFile: function () {
					return true;
				},
				isDirectory: function () {
					return false;
				},
				isBlockDevice: function () {
					return false;
				},
				isCharacterDevice: function () {
					return false;
				},
				isSymbolicLink: function () {
					return false;
				},
				isFIFO: function () {
					return false;
				},
				isSocket: function () {
					return false;
				}
			}
		});

		arr.push(sourceMapFile);

		var sourceMapPathRelative = path.relative(path.dirname(file.path), sourceMapPath);

		if (options.sourceMappingURLPrefix) {
			var prefix = '';
			if (typeof options.sourceMappingURLPrefix === 'function') {
				prefix = options.sourceMappingURLPrefix(file);
			} else {
				prefix = options.sourceMappingURLPrefix;
			}
			sourceMapPathRelative = prefix+path.join('/', sourceMapPathRelative);
		}
		comment = commentFormatter(unixStylePath(sourceMapPathRelative));

		if (options.sourceMappingURL && typeof options.sourceMappingURL === 'function') {
			comment = commentFormatter(options.sourceMappingURL(file));
		}
	}

	// append source map comment
	if (options.addComment) {
		file.contents = Buffer.concat([file.contents, new Buffer(comment)]);
	}

	arr.unshift(file);

	cb(null, arr);

};
