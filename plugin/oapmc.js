var request = require('request')
  , fs = require('fs')
  , url = require('url')
  , http = require('http')
  , exec = require('child_process').exec
  , spawn = require('child_process').spawn
  , jsdom = require('jsdom').jsdom
  , async = require('async')
  , path = require('path')
  , temp = require('temp')
  , _ = require('underscore')
  , emitter = require('events').EventEmitter
  , events = require('events')
  , tar = require('tar')
  , targz = require('tar.gz')
  , Client = require('ftp')
  , xml2js = require('xml2js')
  , DecompressZip = require('decompress-zip')
  , zlib = require('zlib')
  , traverse = require('traverse')
  , recursiveReaddir = require('recursive-readdir')
  , Ldpm = require('../index')
  , DOMParser = require('xmldom').DOMParser;



module.exports = oapmc;


/**
 * 'this' is an Ldpm instance
 */

function oapmc(uri, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var that = this;

  if (uri.slice(0,53)=='http://www.pubmedcentral.nih.gov/utils/oa/oa.fcgi?id=' ){
    // oa -> get pdf and tgz
    var pmcid = _extractBetween(uri,'PMC');
    var convurl = 'http://www.pubmedcentral.nih.gov/utils/idconv/v1.0/?ids='+'PMC'+pmcid+'&format=json';
    that.logHttp('GET', convurl);
    request(convurl, function(error, response, body) {
      that.logHttp(response.statusCode,convurl);
      var res = JSON.parse(response.body);
      if(res.status ==='ok'){
        var doi = res['records'][0]['doi'];
        _parseOAcontent(uri,doi,that,function(err,pkg,mainArticleName){
          if(err) return callback(err);
          uri = 'http://www.pubmedcentral.nih.gov/oai/oai.cgi?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:'+pmcid+'&metadataPrefix=pmc';
          _addMetadata(pkg,mainArticleName,uri,that,function(err,pkg){
            if(err) return callback(err);
            callback(null,pkg);
          });
        });
      } else {
        var err = new Error('this identifier does not belong to the Open Access subset of Pubmed Central');
        err.code = 404; 
        callback(err);
      }
    });
  } else {
    callback(new Error('unrecognized uri'));
  }

};


function _parseOAcontent(uri,doi,that,cb){

  that.logHttp('GET', uri);
  request(uri, function (error, response, body) {
    that.logHttp(response.statusCode,uri);

    if(error) return cb(error);
    if(body.indexOf('idDoesNotExist')>-1){
      var err = new Error('this identifier does not belong to the Open Access subset of Pubmed Central');
      err.code = 404; 
      return cb(err);
    }

    if(body.indexOf('format="tgz"')){
      _fetchTar(body,that, function(err, files){
        if(err) return cb(err);
        _fetchPdfName(body, function(err,mainArticleName){
          if(err) return cb(err);
          var codeBundles = [];
          var compressedBundles = [];
          files.forEach(function(file,i){
            if(['.gz', '.gzip', '.tgz','.zip'].indexOf(path.extname(file))>-1){
              codeBundles.push(path.basename(file,path.extname(file)));
              compressedBundles.push(file);
              files.splice(i,1);
            }
          })
          var opts = { codeBundles: codeBundles };
          var ind = 0;
          async.each(compressedBundles,
            function(f,cb){
              if(path.extname(f)=='.tgz'){
                gzip = new targz();
                gzip.extract(path.join(that.root,f),path.join(that.root,path.basename(f,path.extname(f))), function(err) {
                  return cb(err);
                });
              } else if(path.extname(f)=='.zip') {
                 unzipper = new DecompressZip(path.join(that.root,f));
                 unzipper.on('error', function (err) {
                   return cb(err);
                 });
                 unzipper.on('extract', function (lob) {
                   return cb(null);
                 });
                 unzipper.extract({ path: path.join(that.root,path.basename(f,path.extname(f))) });
              } else {
                zlib.unzip(f, cb);
              }
            },
            function(err){
              if(err) return cb(err);
              var urls = [];
              var plosJournalsList = ['pone.','pbio.','pmed.','pgen.','pcbi.','ppat.','pntd.'];
              var plosJournalsLinks = {
                'pone.': 'http://www.plosone.org/article/info:doi/',
                'pbio.': 'http://www.plosbiology.org/article/info:doi/',
                'pmed.': 'http://www.plosmedicine.org/article/info:doi/',
                'pgen': 'http://www.plosgenetics.org/article/info:doi/',
                'pcbi': 'http://www.ploscompbiol.org/article/info:doi',
                'ppat': 'http://www.plospathogens.org/article/info:doi',
                'pntd': 'http://www.plosntds.org/article/info:doi'
              }
              var tmpfiles = [];
              files.forEach(function(f,i){
                var found = false;
                plosJournalsList.forEach(function(p,j){
                  if(f.slice(0,p.length)===p){
                    if(['.gif','.jpg'].indexOf(path.extname(f))>-1){
                      found = true;
                      var tmp = path.basename(f,path.extname(f));
                      tmp = '.'+tmp.split('.')[tmp.split('.').length-1];
                      if(urls.indexOf(plosJournalsLinks[p] + doi +  tmp + '/' + 'powerpoint')==-1){
                        urls.push(plosJournalsLinks[p] + doi +  tmp  + '/' + 'powerpoint');
                        urls.push(plosJournalsLinks[p] + doi +  tmp  + '/' + 'largerimage');
                        urls.push(plosJournalsLinks[p] + doi +  tmp  + '/' + 'originalimage');
                      }
                    }
                  }
                });
                if(!found){
                  tmpfiles.push(f)
                }
              })
              var validatedurls = [];
              async.each(urls,
                function(uri,cb2){
                  request(uri, function (error, response, body) {
                    if (!error && response.statusCode == 200) {
                      validatedurls.push(uri);
                    }
                    cb2(null);
                  });
                },
                function(err){
                  files = tmpfiles;
                  that.paths2resources(files,opts, function(err,resources){
                    if(err) return cb(err);
                    that.urls2resources(validatedurls, function(err,resourcesFromUrls){
                      if(err) return cb(err);

                      resourcesFromUrls.figure.forEach(function(x){
                        x.name = x.figure[0].contentUrl.split('/')[x.figure[0].contentUrl.split('/').length-2].slice(8);
                      })

                      if(err) return cb(err);
                      for (var type in resources){
                        resources[type] = resources[type].concat(resourcesFromUrls[type]); //merge
                      }
                      if(mainArticleName!=undefined){
                        resources.dataset.forEach(function(x,i){
                          if(x.name===path.basename(mainArticleName,'.pdf').slice(0,path.basename(mainArticleName,'.pdf').lastIndexOf('.'))){
                            resources.dataset.splice(i,1);
                            resources.article.forEach(function(y,i){
                              if(x.name==y.name){
                                var tmp = y.encoding ;
                                tmp.push(x.distribution[0]);
                                resources.article[i].encoding = tmp;
                              }
                            });
                          }
                        });
                      } else {
                        resources.dataset.forEach(function(x,i){
                          if(path.ext(x.distribution.contentPath) == 'nxml'){
                            resources.dataset.splice(i,1);
                            resources.article.push(x);
                            mainArticleName = x.name;
                          }
                        });
                      }
                      ['figure','audio','video'].forEach(
                        function(type){
                          resources[type].forEach(
                            function(r,i){
                              resources[type].slice(i+1,resources[type].length).forEach(
                                function(r2,j){
                                  if(r.name===r2.name){
                                    r[type].push(r2[type][0]);
                                    resources[type].splice(i+j+1,1);
                                  }
                                }
                              )
                            }
                          )
                        }
                      )
                      resources['code'].forEach(
                        function(r,i){
                          resources['code'].slice(i+1,resources['code'].length).forEach(
                            function(r2,j){
                              if(r.name===r2.name){
                                r['targetProduct'].push(r2['targetProduct'][0]);
                                resources['code'].splice(i+j+1,1);
                              }
                            }
                          )
                        }
                      )
                      resources['article'].forEach(
                        function(r,i){
                          resources['article'].slice(i+1,resources['article'].length).forEach(
                            function(r2,j){
                              if(r.name===r2.name){
                                r['encoding'].push(r2['encoding'][0]);
                                resources['article'].splice(i+j+1,1);
                              }
                            }
                          )
                        }
                      )
                      var pkg = _initPkg();
                      if(resources!=undefined){
                        pkg = that.addResources(pkg,resources);
                      }
                      cb(null,pkg,mainArticleName);
                    });
                  });
                }
              );
            }
          )
        });
      });
    }
  });

}


function _fetchTar(body,ldpm,callback){
  var root = ldpm.root
  var href = _extractBetween(body,'href="','"');
  var c = new Client();

  ldpm.logHttp('GET', href.slice(27));
  c.on('ready', function() {
    c.get(href.slice(27), function(err, stream) {
      if (err) return callback(err);
      stream.once('close', function() {
        ldpm.logHttp(200, href.slice(27));
        recursiveReaddir(path.resolve(path.join(root,'__ldpmTmp')), function (err, files) {
          if (err) return callback(err);
          var newFiles = [];
          async.each(files,
            function(file,cb){
              newFiles.push(path.relative(root,file.replace('/__ldpmTmp','')));
              fs.rename(file,file.replace('/__ldpmTmp',''),function(err){
                if(err) return cb(err);
                cb(null)
              });
            },
            function(err){
              fs.rmdir(path.join(root,'__ldpmTmp'),function(err){
                if(err) return callback(err);
                c.end(); callback(null,newFiles);
              });
            }
          )
        });
      });
      stream
        .pipe(zlib.Unzip())
        .pipe(tar.Extract({ path: path.join(root,'__ldpmTmp'), strip: 1 }));
    });
  });
  c.connect({ host: 'ftp.ncbi.nlm.nih.gov' });

}

function _fetchPdfName(body,callback){
  var tmp = _extractBetween(body,'format="pdf"');
  var href = _extractBetween(tmp,'href="','"');
  callback(null,path.basename(href.slice(6)));
}


function _extractBetween(str,str_beg,str_end){
  var beg = str.indexOf(str_beg) + str_beg.length;
  if(arguments.length === 3){
    var end = beg + str.slice(beg,str.length).indexOf(str_end);
  } else {
    var end = str.length;
  }
  return str.slice(beg,end);
}


function _initPkg(uri,article){

  var pkg = {
    version: '0.0.0',
  };

  return pkg;
}


function _findNodePaths(obj,names){
  var paths = {};
  traverse(obj).forEach(function(x){
    if(names.indexOf(this.key)>-1){
      paths[this.key] = this.path;
    }
  });
  return paths;
}

function _findFigures(xmlBody){
  var doc = new DOMParser().parseFromString(xmlBody,'text/xml');
  var figures = [];
  Array.prototype.forEach.call(doc.getElementsByTagName('fig'),function(x){
    var fig = {};
    if(x.getElementsByTagName('label')[0]!=undefined){
      fig.label = x.getElementsByTagName('label')[0].textContent;
    }
    if(fig.label){
      if(fig.label.match(/\d+$/)){
        fig.num = fig.label.match(/\d+$/)[0];
      }
    }
    if(x.getElementsByTagName('caption')[0] != undefined){
      fig.caption = x.getElementsByTagName('caption')[0].textContent.replace(/\n/g,'').trim();
    }
    fig.id = x.getAttribute('id');
    if(x.getElementsByTagName('graphic')[0] != undefined){
      fig.href = x.getElementsByTagName('graphic')[0].getAttribute('xlink:href');
    } else {
      fig.href = undefined
    }
    figures.push(fig);
  });
  Array.prototype.forEach.call(doc.getElementsByTagName('table-wrap'),function(x){
    var fig = {};
    if(x.getElementsByTagName('label')[0]!=undefined){
      fig.label = x.getElementsByTagName('label')[0].textContent;
    }
    if(fig.label){
      if(fig.label.match(/\d+$/)){
        fig.num = fig.label.match(/\d+$/)[0];
      }
    }
    if(x.getElementsByTagName('caption')[0] != undefined){
      fig.caption = x.getElementsByTagName('caption')[0].textContent.replace(/\n/g,'').trim();
    } else if (x.getElementsByTagName('title')[0] != undefined){
      fig.caption = x.getElementsByTagName('title')[0].textContent.replace(/\n/g,'').trim();
    }
    fig.id = x.getAttribute('id');
    if(x.getElementsByTagName('graphic')[0] != undefined){
      fig.href = x.getElementsByTagName('graphic')[0].getAttribute('xlink:href');
    } else {
      fig.href = undefined
    }
    figures.push(fig);
  });
  Array.prototype.forEach.call(doc.getElementsByTagName('supplementary-material'),function(x){
    var fig = {};
    if(x.getElementsByTagName('label')[0]!=undefined){
      fig.label = x.getElementsByTagName('label')[0].textContent;
    }
    if(fig.label){
      if(fig.label.match(/\d+$/)){
        fig.num = fig.label.match(/\d+$/)[0];
      }
    }
    if(x.getElementsByTagName('caption')[0] != undefined){
      fig.caption = x.getElementsByTagName('caption')[0].textContent.replace(/\n/g,'').trim();
    }
    fig.id = x.getAttribute('id');
    if(x.getElementsByTagName('media')[0] != undefined){
      fig.href = x.getElementsByTagName('media')[0].getAttribute('xlink:href');
    } else {
      fig.href = undefined
    }
    figures.push(fig);
  });
  return figures;
}

function _addMetadata(pkg,mainArticleName,uri,ldpm,callback){
  var pmcid = _extractBetween(uri,'PMC');
  var parser = new xml2js.Parser();
  var meta = {};
  var relPaths;

  request(uri,
    function(error,response,body){
      if(error) return callback(error);

      var xmlBody = body;

      var figures = _findFigures(xmlBody);

      parser.parseString(body,function(err,body){
        if(err) return callback(error);

        var pathArt = _findNodePaths(body,['article']);

        //scrap
        if(pathArt['article']){
          if(pkg.article==undefined){
            pkg.article = [{}];
          }
          var data = traverse(body).get(pathArt['article'])[0];
          pkg.article[0]['@type'] = [ 'ScholarlyArticle' ];
          if(data['$']['article-type'] != undefined){
            pkg.article[0].publicationType = data['$']['article-type'].replace(/-/g,' ');
          }
        }

        var absPaths = _findNodePaths(data,['journal-meta','article-meta']);

        var $journalMeta = traverse(data).get(absPaths['journal-meta']);
        relPaths = _findNodePaths($journalMeta,['publisher-name','publisher-loc','journal-title','journal-id','issn']);

        if(relPaths['publisher-name']){
          meta.publisher = {
            name: traverse($journalMeta).get(relPaths['publisher-name'])[0]
          };
        }
        if(relPaths['publisher-loc'] != undefined){
          meta.publisher.location = {
            description: traverse($journalMeta).get(relPaths['publisher-loc'])[0]
          }
        }
        if(relPaths['journal-title']){
          meta.journal = {
            name: traverse($journalMeta).get(relPaths['journal-title'])[0]
          }
        }

        if(relPaths['journal-id']){
          traverse($journalMeta).get(relPaths['journal-id']).forEach(function(x,i){
            if(x['$']['journal-id-type']=='nlm-ta'){
              meta.journalShortName = x['_'].replace(/ /g,'-').replace(/\./g,'-').toLowerCase();
            }
          });
        }
        if(meta.journalShortName==undefined){
          meta.journalShortName = meta.journal.name.replace(/ /g,'-').replace(/\./g,'-').toLowerCase();
        }

        if(relPaths['issn']){
          meta.journal['@id'] = traverse($journalMeta).get(relPaths['issn'])[0]['_'];
        }


        var $articleMeta = traverse(data).get(absPaths['article-meta']);
        relPaths = _findNodePaths($articleMeta,
          [
            'article-id',
            'subj-group',
            'article-title',
            'alt-title',
            'aff',
            'author-notes',
            'contrib-group',
            'pub-date',
            'volume',
            'issue',
            'fpage',
            'lpage',
            'permissions',
            'abstract',
            'page-count',
            'copyright-year',
            'copyright-holder',
            'copyright-statement',
            'license',
            'year',
            'month',
            'day',
            'doi',
            'email'
          ]
        );

        if(relPaths['article-id']){
          traverse($articleMeta).get(relPaths['article-id']).forEach(function(x,i){
            if(x['$']['pub-id-type']=='doi'){
              meta.doi = x['_'];
            } else if (x['$']['pub-id-type']=='pmid'){
              meta.pmid = x['_'];
            }
          });
        }

        if(relPaths['subj-group']){
          var keyword = [];
          traverse($articleMeta).get(relPaths['subj-group']).forEach(function(x){
            keyword = keyword.concat(_extractKeywords(x));
          })
          meta.keyword = keyword;
        }

        if(relPaths['article-title']){
          if(typeof traverse($articleMeta).get(relPaths['article-title'])[0] === 'string'){
            meta.title = traverse($articleMeta).get(relPaths['article-title'])[0];
          } else {
            var doc = new DOMParser().parseFromString(
                '<xml xmlns="a" xmlns:c="./lite">'+
                _extractBetween(xmlBody,'<article-title>','</article-title>') +
                '</xml>'
                ,'text/xml');
            meta.title = doc.lastChild.textContent;
          }
        }

        if(relPaths['alt-title']){
          meta.shortTitle = traverse($articleMeta).get(relPaths['alt-title'])[0]['_'];
        }

        var affiliations = {};
        if(relPaths['aff']){
          traverse($articleMeta).get(relPaths['aff']).forEach(
            function(x){
              var key;
              if(x['$']){
                key = x['$']['id'];
              } else {
                key = 'unknown';
              }
              affiliations[key] =  {};
              var tmp = '';
              if(x['institution']){
                affiliations[key].name = x['institution'][0];
                tmp = x['institution'][0] + '. ';
              }
              if(x['addr-line']){
                affiliations[key].address = {};
                affiliations[key].address.description = x['addr-line'][0];
                tmp += x['addr-line'][0] + '. ';
              }
              if(x['country']){
                if(affiliations[key].address == undefined){
                  affiliations[key].address = {};
                }
                affiliations[key].address.addressCountry = x['country'][0];
                tmp += x['country'][0] + '. ';
              }
              if(tmp!=''){
                affiliations[key].description = tmp;
              } else {
                affiliations[key].description = x['_'];
              }
            }
          );
        }

        var emails = {};
        if(relPaths['author-notes']){
          var found = false;
          traverse($articleMeta).get(relPaths['author-notes']).forEach(
            function(x){
              if(x['corresp']){
                if (x['corresp'][0]['$']){
                  if(x['corresp'][0]['email']){
                    if(x['corresp'][0]['email'][0]['$']){
                      emails[x['corresp'][0]['$']['id']] = x['corresp'][0]['email'][0]['_'];

                    } else {
                      emails[x['corresp'][0]['$']['id']] = x['corresp'][0]['email'][0];
                    }
                    found = true;
                  }
                }
              }
            }
          );
        }

        if(relPaths['email']){
          emails.unkwon = relPaths['email'][0];
        }

        var author;
        var contributor = [];
        var accountablePerson = [];
        var sourceOrganisation = [];
        var sourceNames = [];
        var editor = [];
        if(relPaths['contrib-group']){
          traverse($articleMeta).get(relPaths['contrib-group']).forEach(
            function(x){
              if(x['contrib'][0]['$']['contrib-type']=='author'){
                x['contrib'].forEach(function(y,i){
                  var corresp = false;
                  if(y['name']){
                    if(y['name'][0]['given-names']){
                      if(y['name'][0]['given-names'][0]!=undefined){
                        var givenName = y['name'][0]['given-names'][0];
                      }
                    }
                    if(y['name'][0]['surname']){
                      if(y['name'][0]['surname'][0]!=undefined){
                        var familyName = y['name'][0]['surname'][0];
                      }
                    }
                    var affiliation = [];
                    var email = '';
                    if(y.xref){
                      y.xref.forEach(function(z){
                        if(z['$']['ref-type']){
                          if (z['$']['ref-type'] == 'aff'){
                            if(affiliations.unknown != undefined){
                              affiliation.push( affiliations.unknown );
                            } else {
                              if(affiliations[z['$']['rid']]!=undefined){
                                affiliation.push( affiliations[z['$']['rid']] );
                              }
                            }
                          } else if (z['$']['ref-type'] == 'corresp'){
                            if(emails[z['$']['rid']]){
                              email = emails[z['$']['rid']];
                            } else {
                              email = emails['unknown'];
                            }
                            corresp = true;
                          }
                        } else {
                          if(affiliations.unknown !=  undefined){
                            affiliation.push( affiliations.unknown );
                          }
                        }
                      });
                    } else {
                      if(affiliations.unknown !=  undefined){
                        affiliation.push( affiliations.unknown );
                      }
                    }
                    if(affiliation.length == 0){
                      if(affiliations.unknown !=  undefined){
                        affiliation.push( affiliations.unknown );
                      }
                    }

                    if(y['email']){
                      email = y['email'][0]
                      if(y['$']['corresp']=='yes'){
                        corresp = true;
                      }
                    }

                    affiliation.forEach(function(y){
                      if(sourceNames.indexOf(y.description)==-1){
                        sourceOrganisation.push(y);
                        sourceNames.push(y.description);
                      }
                    });

                    if(i==0){
                      author = {}
                      var tmpname = '';
                      if(givenName){
                        author.givenName = givenName;
                        tmpname += givenName + ' ';
                      }
                      if(familyName){
                        author.familyName = familyName;
                        tmpname += familyName;
                      }
                      if(tmpname.length){
                        author.name = tmpname;
                      }
                      if (email != ''){
                        author.email = email
                      }
                      if(affiliation.length){
                        if(affiliation[0]!={}){
                          author.affiliation = affiliation;
                        }
                      }
                    } else {
                      var tmpcontr = {};
                      var tmpname = '';
                      if(givenName){
                        tmpcontr.givenName = givenName;
                        tmpname += givenName + ' ';
                      }
                      if(familyName){
                        tmpcontr.familyName = familyName;
                        tmpname += familyName;
                      }
                      if(tmpname.length){
                        tmpcontr.name = tmpname;
                      }
                      if(affiliation.length){
                        if(affiliation.length==1){
                          tmpcontr.affiliation = affiliation[0];
                        } else {
                          tmpcontr.affiliation = affiliation;
                        }
                      }
                      if(email!=''){
                        tmpcontr.email = email;
                      }
                      contributor.push(tmpcontr);
                    }
                    if (corresp){
                      var tmpacc = {};
                      var tmpname = '';
                      if(givenName){
                        tmpacc.givenName = givenName;
                        tmpname += givenName + ' ';
                      }
                      if(familyName){
                        tmpacc.familyName = familyName;
                        tmpname += familyName;
                      }
                      if(tmpname.length){
                        tmpacc.name = tmpname;
                      }
                      if(affiliation.length){
                        if(affiliation.length==1){
                          tmpacc.affiliation = affiliation[0];
                        } else {
                          tmpacc.affiliation = affiliation;
                        }
                      }
                      if(email!=''){
                        tmpacc.email = email;
                      }
                      accountablePerson.push(tmpacc);
                    }
                  }

                  
                });
              } else if (x['contrib'][0]['$']['contrib-type']=='editor'){
                x['contrib'].forEach(function(y,i){
                  if(y['name']){
                    if(y['name'][0]['given-names']){
                      var givenName = y['name'][0]['given-names'][0];
                    }
                    if(y['name'][0]['surname']){
                      var familyName = y['name'][0]['surname'][0];
                    }
                    var tmped = {};
                    var tmpname = '';
                    if(givenName){
                      tmped.givenName = givenName;
                      tmpname += givenName + ' ';
                    }
                    if(familyName){
                      tmped.familyName = familyName;
                      tmpname += familyName;
                    }
                    if(tmpname.length){
                      tmped.name = tmpname;
                    }
                    var affiliation = [];
                    if(y.xref){
                      y.xref.forEach(function(z){
                        if (z['$']['ref-type'] == 'aff'){
                          affiliation.push( affiliations[z['$']['rid']] );
                        }
                      });
                    }
                    if(affiliation.length){
                      if(affiliation.length==1){
                        tmped.affiliation = affiliation[0];
                      } else {
                        tmped.affiliation = affiliation;
                      }
                    }
                    editor.push(tmped);
                  }
                });
              }
            }
          );
        }

        meta.author = author;
        meta.contributor = contributor;
        meta.editor = editor;
        meta.accountablePerson = accountablePerson;
        meta.sourceOrganisation = sourceOrganisation;

        var tmpDate = traverse($articleMeta).get(relPaths['year'])[0];
        if(relPaths['month']){
          tmpDate += '-'+ traverse($articleMeta).get(relPaths['month'])[0];
        }
        if(relPaths['day']){
          tmpDate += '-'+ traverse($articleMeta).get(relPaths['day'])[0];
        }
        meta.publicationDate = (new Date(tmpDate).toISOString());
        meta.year = traverse($articleMeta).get(relPaths['year'])[0];

        if(relPaths['volume']){
          meta.volume = parseInt(traverse($articleMeta).get(relPaths['volume'])[0],10);
        }
        if(relPaths['issue']){
          meta.issue = parseInt(traverse($articleMeta).get(relPaths['issue'])[0],10);
        }
        if(relPaths['fpage']){
          meta.pageStart = parseInt(traverse($articleMeta).get(relPaths['fpage'])[0],10);
        }
        if(relPaths['lpage']){
          meta.pageEnd = parseInt(traverse($articleMeta).get(relPaths['lpage'])[0],10);
        }
        if(relPaths['copyright-year']){
          meta.copyrightYear = traverse($articleMeta).get(relPaths['copyright-year'])[0];
        }
        if(relPaths['copyright-holder']){
          meta.copyrightHolder = {
            description: traverse($articleMeta).get(relPaths['copyright-holder'])[0]
          }
        }

        if(relPaths['license']){
          if(traverse($articleMeta).get(relPaths['license'])[0]['$']){
            meta.license = traverse($articleMeta).get(relPaths['license'])[0]['$']['xlink:href']; 
          }
        } else {
          if(relPaths['copyright-statement']){
            meta.license = traverse($articleMeta).get(relPaths['copyright-statement'])[0];
          }
        }

        if(relPaths['abstract']){
          if(xmlBody.indexOf('<abstract>')>-1){
            var doc = new DOMParser().parseFromString(
                '<xml xmlns="a" xmlns:c="./lite">'+
                _extractBetween(xmlBody,'<abstract>','</abstract>') +
                '</xml>'
                ,'text/xml');
            meta.abstract = doc.lastChild.textContent.trim();
          }
        }

        if(relPaths['page-count']){
          meta.numPages = traverse($articleMeta).get(relPaths['page-count'])[0]['$']['count'];
        }

        references = [];

        if(data.back){

          if(data.back[0]['ref-list']){
            data.back[0]['ref-list'][0]['ref'].forEach(function(x){

              Object.keys(x).forEach(function(k){
                if(k.indexOf('citation')>-1){
                  y = x[k][0];
                }
              })


              // if (y['$']['publication-type'] == 'journal'){

                var ref = {
                  '@type': [ 'ScholarlyArticle' ],
                  header: y['article-title']
                };

                if(relPaths['year']){
                  ref.publicationDate = (new Date(traverse($articleMeta).get(relPaths['year'])[0])).toISOString();
                }

                ref.header = '';
                if(typeof y['article-title'] === 'string'){
                  ref.header = y['article-title'];
                } else {
                  var id = x['$']['id'];
                  var tmp = _extractBetween(xmlBody,'<ref id="'+id+'">','</ref>');
                  if(tmp.indexOf('<article-title>')>-1){
                    tmp = _extractBetween(tmp,'<article-title>','</article-title>');
                    var doc = new DOMParser().parseFromString(
                        '<xml xmlns="a" xmlns:c="./lite">'+
                        tmp+
                        '</xml>'
                        ,'text/xml');
                    ref.header = doc.lastChild.textContent;
                  } else if(y['source']){
                      ref.header = y['source'];
                  }
                }

                if( y['source']){
                  ref.journal = y['source'][0],10;
                }
                if( y['volume']){
                  ref.volume = parseInt(y['volume'][0],10);
                }
                if( y['fpage']){
                  ref.pageStart = parseInt(y['fpage'][0],10);
                }
                if( y['lpage']){
                  ref.pageEnd = parseInt(y['lpage'][0]);
                }
                if( y['comment']){
                  y['comment'].forEach(function(y){
                    if(typeof y != 'string'){
                      if(y['_'] == 'doi:'){
                        ref.doi = y['ext-link'][0]['_'];
                      }
                      if(y['_'] == 'pmid:'){
                        ref.pmid = y['ext-link'][0]['_'];
                      }
                    }
                  });
                }
                if(ref.doi == undefined){
                  if(y['pub-id']){
                    y['pub-id'].forEach(function(z){
                      if(z['$']['pub-id-type']=='doi'){
                        ref.doi = z['_'];
                      }
                      if(z['$']['pub-id-type']=='pmid'){
                        ref.pmid = z['_'];
                      }
                    });
                  }
                }

                if(ref.doi != undefined){
                  ref.url = 'http://doi.org/'+ref.doi;
                  if(ref.pmid){
                    ref.sameAs = 'http://www.ncbi.nlm.nih.gov/pubmed/?term=' + ref.pmid;
                  }
                } else {
                  if(ref.pmid){
                    ref.url = 'http://www.ncbi.nlm.nih.gov/pubmed/?term=' + ref.pmid;
                  }
                }

                var tmpName;
                if(y['name']){
                  tmpName = y['name'];
                } else if (y['person-group']){
                  tmpName = y['person-group'][0]['name'];
                }
                if(tmpName){
                  tmpName.forEach(function(z,i){
                    if(z['given-names']){
                      var givenName  = z['given-names'][0];
                    }
                    if(z['surname']){
                      var familyName = z['surname'][0];
                    }
                    var tmpauth = {};
                    var tmpname = '';
                    if(givenName){
                      tmpauth.givenName = givenName;
                      tmpname += givenName + ' ';
                    }
                    if(familyName){
                      tmpauth.familyName = familyName;
                      tmpname += familyName;
                    }
                    if(tmpname.length){
                      tmpauth.name = tmpname;
                    }
                    if(i==0){
                      ref.author = tmpauth;
                    } else {
                      if(ref.contributor == undefined){
                        ref.contributor = [];
                      }
                      ref.contributor.push(tmpauth);
                    }
                  });
                }

                var descr = '';

                if(ref.author){
                  if(ref.author.familyName){
                    descr += ref.author.familyName + ' ';
                  }
                  if(ref.author.givenName){
                    descr += ref.author.givenName;
                  }
                }
                if(ref.contributor){
                  ref.contributor.forEach(function(x,i){
                    if (i<4){
                      descr += ', ';
                      if(ref.author.familyName){
                        descr += x.familyName + ' ';
                      }
                      if(ref.author.givenName){
                        descr += x.givenName;
                      }
                    } else if (i==5){
                      descr += ', et al.';
                    }
                  });
                }
                if(y['year']){
                  descr += ' ('+y['year']+') ';
                }
                if(ref.header){
                  descr += ref.header;
                  if(ref.header[ref.header.length-1]!='.'){
                    descr += '.';
                  };
                  descr += ' ';
                }
                if (ref.journal){
                  descr += ref.journal + ' ';
                }
                if (ref.volume){
                  descr += ref.volume + ': ';
                }
                if (ref.pageStart){
                  descr += ref.pageStart;
                }
                if (ref.pageEnd){
                  descr += '-'+ref.pageEnd;
                }
                descr += '.';
                ref.description = descr;

                if(ref.header){
                  references.push(ref);
                }
              // }
            });
          }
        }

        if(references.length){
          meta.references = references;
        }

        // Fill pkg, controlling the order
        var newpkg = {};
        newpkg.name = '';
        if(meta.journalShortName){
          newpkg.name += meta.journalShortName;
        }
        if(meta.author){
          if(meta.author.familyName){
            newpkg.name += '-' + removeDiacritics(meta.author.familyName.toLowerCase()).replace(/\W/g, '');
          } else {
            callback(new Error('did not find the author family name'));
          }
        } else {
          newpkg.name += '-' + removeDiacritics(meta.title.split(' ')[0].toLowerCase()).replace(/\W/g, '');
        }

        if(meta.year){
          newpkg.name += '-' + meta.year;
        } else {
          callback(new Error('did not find the year'));
        }

        newpkg.version = pkg.version;

        if(meta.keyword){
          newpkg.keyword = meta.keyword;
        }
        if(meta.title){
          newpkg.description = meta.title;
        }
        newpkg.datePublished = (new Date()).toISOString();

        if(meta.license){
          newpkg.license = 'CC0-1.0';
        }
        if(meta.url){
          newpkg.sameAs = meta.url;
        }
        newpkg.author =  {
          '@type': 'Organization',
          name: 'Standard Analytics IO',
          email: 'contact@standardanalytics.io'
        };

        if(meta.accountablePerson.length){
          newpkg.accountablePerson = meta.accountablePerson;
        }

        if( meta.copyrightHolder ){
          newpkg.copyrightHolder = meta.copyrightHolder;
        } else if (meta.publisher) {
          newpkg.copyrightHolder = meta.publisher;
        }


        ['dataset','code','figure','audio','video','article'].forEach(function(type){
          if (pkg[type] != undefined){
            pkg[type].forEach(function(x,i){
              if(x.name==undefined){
                x.name = type+'-'+i;
              }
              x.name = x.name.replace(/\./g,'-');
              if(meta.author){
                x.author = meta.author;
              }
              if(meta.contributor.length){
                x.contributor = meta.contributor;
              }
              if (meta.accountablePerson.length){
                x.accountablePerson = meta.accountablePerson;
              }
              if(meta.sourceOrganisation.length){
                if(meta.sourceOrganisation[0] != {}){
                  x.sourceOrganisation = meta.sourceOrganisation;
                }
              }
              if (meta.editor.length){
                x.editor = meta.editor;
              }
              if(meta.publisher){
                x.publisher = meta.publisher;
              }
              if(meta.publicationDate){
                x.datePublished = meta.publicationDate;
              }
              if(meta.journal){
                x.journal = meta.journal;
              }
              if(meta.publisher){
                x.copyrightHolder = meta.publisher;
              }
              pkg[type][i] = x;

              figures.forEach(function(fig){
                var v = [fig.id, fig.href];
                if(fig.id){
                  v.push(fig.id.replace(/\./g,'-'));
                }
                if(fig.href){
                  v.push(fig.href.replace(/\./g,'-'));
                }
                if( v.indexOf(x.name) > -1 ){
                  var descr = '';
                  if (fig.label){
                    descr = fig.label + '. ';
                  }
                  if (fig.caption){
                    x.caption = fig.caption;
                    descr += fig.caption;
                  }
                  if(descr.length){
                    x.description = descr;
                  }
                }
              });

            });
          }
          newpkg[type] = pkg[type];
        });
        

        var plosJournalsList = ['pone-','pbio-','pmed-','pgen-','pcbi-','ppat-','pntd-'];
        if(newpkg.figure){
          newpkg.figure.forEach(function(x){
            plosJournalsList.forEach(function(p,j){
              if(x.name.slice(0,p.length)===p){
                x.doi = meta.doi + '.' + x.name.split('-')[x.name.split('-').length-1];
              }
            });
          });
        }

        if (mainArticleName != undefined){
          pkg.article.forEach(function(x,i){
            if(x.name==mainArticleName.slice(0,path.basename(mainArticleName,'.pdf').lastIndexOf('.')).replace(/\./g,'-')){
              var article = x;
              if(meta.journal){
                article.journal = meta.journal;
              }
              if(meta.doi){
                article.doi = meta.doi;
              }
              if(meta.pmid){
                article.pmid = meta.pmid;
              }
              if(meta.title){
                article.headline = meta.title;
              }
              if (meta.abstract){
                article.abstract = meta.abstract;
              }
              if(meta.references){
                article.citation = meta.references;
              }
              if(meta.issue){
                article.issue = meta.issue;
              }
              if(meta.volume){
                article.volume = meta.volume;
              }
              if(meta.pageStart){
                article.pageStart = meta.pageStart;
              }
              if(meta.pageEnd){
                article.pageEnd = meta.pageEnd;
              }
              pkg.article[i] = article;
              var doc = new DOMParser().parseFromString(xmlBody,'text/xml');
              if(doc.getElementsByTagName('body').length){
                pkg.article[i].articleBody = doc.getElementsByTagName('body')[0].textContent;
              }
            }

          });
          
        } else {
          // in case there is no pdf
          var article = {};
          if(meta.journal){
            article.journal = meta.journal;
          }
          if(meta.doi){
            article.doi = meta.doi;
          }
          if(meta.pmid){
            article.pmid = meta.pmid;
          }
          if(meta.title){
            article.headline = meta.title;
          }
          if (meta.abstract){
            article.abstract = meta.abstract;
          }
          if(meta.reference.length){
            article.citation = meta.references;
          }
          if(meta.issue){
            article.issue = meta.issue;
          }
          if(meta.volume){
            article.volume = meta.volume;
          }
          if(meta.pageStart){
            article.pageStart = meta.pageStart;
          }
          if(meta.pageEnd){
            article.pageEnd = meta.pageEnd;
          }
          pkg.article.push(article);
        }        
        newpkg.article = pkg.article;

        // call pubmed to check if there isn't additional info there
        ldpm.markup('pubmed', meta.pmid, function(err,pubmed_pkg){
          if(pubmed_pkg){
            if(pubmed_pkg.keyword){
              if(newpkg.keyword==undefined) newpkg.keyword = [];
              pubmed_pkg.keyword.forEach(function(x){
                if(newpkg.keyword.indexOf(x)==-1){
                  newpkg.keyword.push(x);
                }
              })
            }
            if(pubmed_pkg.rawChemical){
              newpkg.rawChemical = pubmed_pkg.rawChemical;
            }
            if(pubmed_pkg.rawMesh){
              newpkg.rawMesh = pubmed_pkg.rawMesh;
            } 
          }
          callback(null,newpkg);
        });

      })
    }
  );
}


function _extractKeywords(obj){
  if(obj['subj-group']!=undefined){
    var res = obj['subject'];
    obj['subj-group'].forEach(function(x){
      res = res.concat(_extractKeywords(x));
    })
    return res;
  } else {
    return obj['subject'];
  }
}

var defaultDiacriticsRemovalMap = [
    {'base':'A', 'letters':/[\u0041\u24B6\uFF21\u00C0\u00C1\u00C2\u1EA6\u1EA4\u1EAA\u1EA8\u00C3\u0100\u0102\u1EB0\u1EAE\u1EB4\u1EB2\u0226\u01E0\u00C4\u01DE\u1EA2\u00C5\u01FA\u01CD\u0200\u0202\u1EA0\u1EAC\u1EB6\u1E00\u0104\u023A\u2C6F]/g},
    {'base':'AA','letters':/[\uA732]/g},
    {'base':'AE','letters':/[\u00C6\u01FC\u01E2]/g},
    {'base':'AO','letters':/[\uA734]/g},
    {'base':'AU','letters':/[\uA736]/g},
    {'base':'AV','letters':/[\uA738\uA73A]/g},
    {'base':'AY','letters':/[\uA73C]/g},
    {'base':'B', 'letters':/[\u0042\u24B7\uFF22\u1E02\u1E04\u1E06\u0243\u0182\u0181]/g},
    {'base':'C', 'letters':/[\u0043\u24B8\uFF23\u0106\u0108\u010A\u010C\u00C7\u1E08\u0187\u023B\uA73E]/g},
    {'base':'D', 'letters':/[\u0044\u24B9\uFF24\u1E0A\u010E\u1E0C\u1E10\u1E12\u1E0E\u0110\u018B\u018A\u0189\uA779]/g},
    {'base':'DZ','letters':/[\u01F1\u01C4]/g},
    {'base':'Dz','letters':/[\u01F2\u01C5]/g},
    {'base':'E', 'letters':/[\u0045\u24BA\uFF25\u00C8\u00C9\u00CA\u1EC0\u1EBE\u1EC4\u1EC2\u1EBC\u0112\u1E14\u1E16\u0114\u0116\u00CB\u1EBA\u011A\u0204\u0206\u1EB8\u1EC6\u0228\u1E1C\u0118\u1E18\u1E1A\u0190\u018E]/g},
    {'base':'F', 'letters':/[\u0046\u24BB\uFF26\u1E1E\u0191\uA77B]/g},
    {'base':'G', 'letters':/[\u0047\u24BC\uFF27\u01F4\u011C\u1E20\u011E\u0120\u01E6\u0122\u01E4\u0193\uA7A0\uA77D\uA77E]/g},
    {'base':'H', 'letters':/[\u0048\u24BD\uFF28\u0124\u1E22\u1E26\u021E\u1E24\u1E28\u1E2A\u0126\u2C67\u2C75\uA78D]/g},
    {'base':'I', 'letters':/[\u0049\u24BE\uFF29\u00CC\u00CD\u00CE\u0128\u012A\u012C\u0130\u00CF\u1E2E\u1EC8\u01CF\u0208\u020A\u1ECA\u012E\u1E2C\u0197]/g},
    {'base':'J', 'letters':/[\u004A\u24BF\uFF2A\u0134\u0248]/g},
    {'base':'K', 'letters':/[\u004B\u24C0\uFF2B\u1E30\u01E8\u1E32\u0136\u1E34\u0198\u2C69\uA740\uA742\uA744\uA7A2]/g},
    {'base':'L', 'letters':/[\u004C\u24C1\uFF2C\u013F\u0139\u013D\u1E36\u1E38\u013B\u1E3C\u1E3A\u0141\u023D\u2C62\u2C60\uA748\uA746\uA780]/g},
    {'base':'LJ','letters':/[\u01C7]/g},
    {'base':'Lj','letters':/[\u01C8]/g},
    {'base':'M', 'letters':/[\u004D\u24C2\uFF2D\u1E3E\u1E40\u1E42\u2C6E\u019C]/g},
    {'base':'N', 'letters':/[\u004E\u24C3\uFF2E\u01F8\u0143\u00D1\u1E44\u0147\u1E46\u0145\u1E4A\u1E48\u0220\u019D\uA790\uA7A4]/g},
    {'base':'NJ','letters':/[\u01CA]/g},
    {'base':'Nj','letters':/[\u01CB]/g},
    {'base':'O', 'letters':/[\u004F\u24C4\uFF2F\u00D2\u00D3\u00D4\u1ED2\u1ED0\u1ED6\u1ED4\u00D5\u1E4C\u022C\u1E4E\u014C\u1E50\u1E52\u014E\u022E\u0230\u00D6\u022A\u1ECE\u0150\u01D1\u020C\u020E\u01A0\u1EDC\u1EDA\u1EE0\u1EDE\u1EE2\u1ECC\u1ED8\u01EA\u01EC\u00D8\u01FE\u0186\u019F\uA74A\uA74C]/g},
    {'base':'OI','letters':/[\u01A2]/g},
    {'base':'OO','letters':/[\uA74E]/g},
    {'base':'OU','letters':/[\u0222]/g},
    {'base':'P', 'letters':/[\u0050\u24C5\uFF30\u1E54\u1E56\u01A4\u2C63\uA750\uA752\uA754]/g},
    {'base':'Q', 'letters':/[\u0051\u24C6\uFF31\uA756\uA758\u024A]/g},
    {'base':'R', 'letters':/[\u0052\u24C7\uFF32\u0154\u1E58\u0158\u0210\u0212\u1E5A\u1E5C\u0156\u1E5E\u024C\u2C64\uA75A\uA7A6\uA782]/g},
    {'base':'S', 'letters':/[\u0053\u24C8\uFF33\u1E9E\u015A\u1E64\u015C\u1E60\u0160\u1E66\u1E62\u1E68\u0218\u015E\u2C7E\uA7A8\uA784]/g},
    {'base':'T', 'letters':/[\u0054\u24C9\uFF34\u1E6A\u0164\u1E6C\u021A\u0162\u1E70\u1E6E\u0166\u01AC\u01AE\u023E\uA786]/g},
    {'base':'TZ','letters':/[\uA728]/g},
    {'base':'U', 'letters':/[\u0055\u24CA\uFF35\u00D9\u00DA\u00DB\u0168\u1E78\u016A\u1E7A\u016C\u00DC\u01DB\u01D7\u01D5\u01D9\u1EE6\u016E\u0170\u01D3\u0214\u0216\u01AF\u1EEA\u1EE8\u1EEE\u1EEC\u1EF0\u1EE4\u1E72\u0172\u1E76\u1E74\u0244]/g},
    {'base':'V', 'letters':/[\u0056\u24CB\uFF36\u1E7C\u1E7E\u01B2\uA75E\u0245]/g},
    {'base':'VY','letters':/[\uA760]/g},
    {'base':'W', 'letters':/[\u0057\u24CC\uFF37\u1E80\u1E82\u0174\u1E86\u1E84\u1E88\u2C72]/g},
    {'base':'X', 'letters':/[\u0058\u24CD\uFF38\u1E8A\u1E8C]/g},
    {'base':'Y', 'letters':/[\u0059\u24CE\uFF39\u1EF2\u00DD\u0176\u1EF8\u0232\u1E8E\u0178\u1EF6\u1EF4\u01B3\u024E\u1EFE]/g},
    {'base':'Z', 'letters':/[\u005A\u24CF\uFF3A\u0179\u1E90\u017B\u017D\u1E92\u1E94\u01B5\u0224\u2C7F\u2C6B\uA762]/g},
    {'base':'a', 'letters':/[\u0061\u24D0\uFF41\u1E9A\u00E0\u00E1\u00E2\u1EA7\u1EA5\u1EAB\u1EA9\u00E3\u0101\u0103\u1EB1\u1EAF\u1EB5\u1EB3\u0227\u01E1\u00E4\u01DF\u1EA3\u00E5\u01FB\u01CE\u0201\u0203\u1EA1\u1EAD\u1EB7\u1E01\u0105\u2C65\u0250]/g},
    {'base':'aa','letters':/[\uA733]/g},
    {'base':'ae','letters':/[\u00E6\u01FD\u01E3]/g},
    {'base':'ao','letters':/[\uA735]/g},
    {'base':'au','letters':/[\uA737]/g},
    {'base':'av','letters':/[\uA739\uA73B]/g},
    {'base':'ay','letters':/[\uA73D]/g},
    {'base':'b', 'letters':/[\u0062\u24D1\uFF42\u1E03\u1E05\u1E07\u0180\u0183\u0253]/g},
    {'base':'c', 'letters':/[\u0063\u24D2\uFF43\u0107\u0109\u010B\u010D\u00E7\u1E09\u0188\u023C\uA73F\u2184]/g},
    {'base':'d', 'letters':/[\u0064\u24D3\uFF44\u1E0B\u010F\u1E0D\u1E11\u1E13\u1E0F\u0111\u018C\u0256\u0257\uA77A]/g},
    {'base':'dz','letters':/[\u01F3\u01C6]/g},
    {'base':'e', 'letters':/[\u0065\u24D4\uFF45\u00E8\u00E9\u00EA\u1EC1\u1EBF\u1EC5\u1EC3\u1EBD\u0113\u1E15\u1E17\u0115\u0117\u00EB\u1EBB\u011B\u0205\u0207\u1EB9\u1EC7\u0229\u1E1D\u0119\u1E19\u1E1B\u0247\u025B\u01DD]/g},
    {'base':'f', 'letters':/[\u0066\u24D5\uFF46\u1E1F\u0192\uA77C]/g},
    {'base':'g', 'letters':/[\u0067\u24D6\uFF47\u01F5\u011D\u1E21\u011F\u0121\u01E7\u0123\u01E5\u0260\uA7A1\u1D79\uA77F]/g},
    {'base':'h', 'letters':/[\u0068\u24D7\uFF48\u0125\u1E23\u1E27\u021F\u1E25\u1E29\u1E2B\u1E96\u0127\u2C68\u2C76\u0265]/g},
    {'base':'hv','letters':/[\u0195]/g},
    {'base':'i', 'letters':/[\u0069\u24D8\uFF49\u00EC\u00ED\u00EE\u0129\u012B\u012D\u00EF\u1E2F\u1EC9\u01D0\u0209\u020B\u1ECB\u012F\u1E2D\u0268\u0131]/g},
    {'base':'j', 'letters':/[\u006A\u24D9\uFF4A\u0135\u01F0\u0249]/g},
    {'base':'k', 'letters':/[\u006B\u24DA\uFF4B\u1E31\u01E9\u1E33\u0137\u1E35\u0199\u2C6A\uA741\uA743\uA745\uA7A3]/g},
    {'base':'l', 'letters':/[\u006C\u24DB\uFF4C\u0140\u013A\u013E\u1E37\u1E39\u013C\u1E3D\u1E3B\u017F\u0142\u019A\u026B\u2C61\uA749\uA781\uA747]/g},
    {'base':'lj','letters':/[\u01C9]/g},
    {'base':'m', 'letters':/[\u006D\u24DC\uFF4D\u1E3F\u1E41\u1E43\u0271\u026F]/g},
    {'base':'n', 'letters':/[\u006E\u24DD\uFF4E\u01F9\u0144\u00F1\u1E45\u0148\u1E47\u0146\u1E4B\u1E49\u019E\u0272\u0149\uA791\uA7A5]/g},
    {'base':'nj','letters':/[\u01CC]/g},
    {'base':'o', 'letters':/[\u006F\u24DE\uFF4F\u00F2\u00F3\u00F4\u1ED3\u1ED1\u1ED7\u1ED5\u00F5\u1E4D\u022D\u1E4F\u014D\u1E51\u1E53\u014F\u022F\u0231\u00F6\u022B\u1ECF\u0151\u01D2\u020D\u020F\u01A1\u1EDD\u1EDB\u1EE1\u1EDF\u1EE3\u1ECD\u1ED9\u01EB\u01ED\u00F8\u01FF\u0254\uA74B\uA74D\u0275]/g},
    {'base':'oi','letters':/[\u01A3]/g},
    {'base':'ou','letters':/[\u0223]/g},
    {'base':'oo','letters':/[\uA74F]/g},
    {'base':'p','letters':/[\u0070\u24DF\uFF50\u1E55\u1E57\u01A5\u1D7D\uA751\uA753\uA755]/g},
    {'base':'q','letters':/[\u0071\u24E0\uFF51\u024B\uA757\uA759]/g},
    {'base':'r','letters':/[\u0072\u24E1\uFF52\u0155\u1E59\u0159\u0211\u0213\u1E5B\u1E5D\u0157\u1E5F\u024D\u027D\uA75B\uA7A7\uA783]/g},
    {'base':'s','letters':/[\u0073\u24E2\uFF53\u00DF\u015B\u1E65\u015D\u1E61\u0161\u1E67\u1E63\u1E69\u0219\u015F\u023F\uA7A9\uA785\u1E9B]/g},
    {'base':'t','letters':/[\u0074\u24E3\uFF54\u1E6B\u1E97\u0165\u1E6D\u021B\u0163\u1E71\u1E6F\u0167\u01AD\u0288\u2C66\uA787]/g},
    {'base':'tz','letters':/[\uA729]/g},
    {'base':'u','letters':/[\u0075\u24E4\uFF55\u00F9\u00FA\u00FB\u0169\u1E79\u016B\u1E7B\u016D\u00FC\u01DC\u01D8\u01D6\u01DA\u1EE7\u016F\u0171\u01D4\u0215\u0217\u01B0\u1EEB\u1EE9\u1EEF\u1EED\u1EF1\u1EE5\u1E73\u0173\u1E77\u1E75\u0289]/g},
    {'base':'v','letters':/[\u0076\u24E5\uFF56\u1E7D\u1E7F\u028B\uA75F\u028C]/g},
    {'base':'vy','letters':/[\uA761]/g},
    {'base':'w','letters':/[\u0077\u24E6\uFF57\u1E81\u1E83\u0175\u1E87\u1E85\u1E98\u1E89\u2C73]/g},
    {'base':'x','letters':/[\u0078\u24E7\uFF58\u1E8B\u1E8D]/g},
    {'base':'y','letters':/[\u0079\u24E8\uFF59\u1EF3\u00FD\u0177\u1EF9\u0233\u1E8F\u00FF\u1EF7\u1E99\u1EF5\u01B4\u024F\u1EFF]/g},
    {'base':'z','letters':/[\u007A\u24E9\uFF5A\u017A\u1E91\u017C\u017E\u1E93\u1E95\u01B6\u0225\u0240\u2C6C\uA763]/g}
];

var changes;
function removeDiacritics (str) {
    if(!changes) {
        changes = defaultDiacriticsRemovalMap;
    }
    for(var i=0; i<changes.length; i++) {
        str = str.replace(changes[i].letters, changes[i].base);
    }
    return str;
}