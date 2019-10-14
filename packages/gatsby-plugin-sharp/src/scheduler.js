const _ = require(`lodash`)
const { existsSync } = require(`fs`)
const uuidv4 = require(`uuid/v4`)
const queue = require(`async/queue`)
const { processFile } = require(`./process-file`)
const { createProgress } = require(`./utils`)

const toProcess = {}
let totalJobs = 0
const q = queue((task, callback) => {
  task(callback)
}, 1)

let bar
// when the queue is empty we stop the progressbar
q.drain = () => {
  if (bar) {
    bar.done()
  }
  totalJobs = 0
}

const getFileKey = filePath => filePath.replace(/\./g, `%2E`)

const setJobToProcess = (toProcess, job, deferred) => {
  const inputFileKey = getFileKey(job.inputPath)
  const outputFileKey = getFileKey(job.outputPath)
  const jobPath = `["${inputFileKey}"].["${outputFileKey}"]`

  // Check if the job has already been queued. If it has, there's nothing
  // to do, return.
  if (_.has(toProcess, jobPath)) {
    return { existingPromise: _.get(toProcess, `${jobPath}.deferred.promise`) }
  }

  // Check if the output file already exists so we don't redo work.
  if (existsSync(job.outputPath)) {
    return { existingPromise: Promise.resolve(job) }
  }

  let isQueued = false
  if (toProcess[inputFileKey]) {
    isQueued = true
  }

  _.set(toProcess, jobPath, {
    job: job,
    deferred,
  })

  return { isQueued }
}

const scheduleJob = async (
  job,
  boundActionCreators,
  pluginOptions,
  reporter,
  reportStatus = true
) => {
  // deferred naming comes from https://developer.mozilla.org/en-US/docs/Mozilla/JavaScript_code_modules/Promise.jsm/Deferred
  let deferred = {}
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve
    deferred.reject = reject
  })

  const { existingPromise, isQueued } = setJobToProcess(
    toProcess,
    job,
    deferred
  )
  if (existingPromise) {
    return existingPromise
  }

  if (totalJobs === 0) {
    bar = createProgress(`Generating image thumbnails`, reporter)
    bar.start()
  }
  totalJobs += 1

  if (!isQueued) {
    // Create image job
    const jobId = uuidv4()
    boundActionCreators.createJob(
      {
        id: jobId,
        description: `processing image ${job.inputPath}`,
        imagesCount: 1,
      },
      { name: `gatsby-plugin-sharp` }
    )

    q.push(cb => {
      runJobs(
        jobId,
        getFileKey(job.inputPath),
        boundActionCreators,
        pluginOptions,
        reportStatus,
        cb
      )
    })
  }

  return deferred.promise
}

function runJobs(
  jobId,
  inputFileKey,
  boundActionCreators,
  pluginOptions,
  reportStatus,
  cb
) {
  const jobs = _.values(toProcess[inputFileKey])
  const findDeferred = job => jobs.find(j => j.job === job).deferred
  const { job } = jobs[0]

  // Delete the input key from the toProcess list so more jobs can be queued.
  delete toProcess[inputFileKey]

  // Update job info
  boundActionCreators.setJob(
    {
      id: jobId,
      imagesCount: jobs.length,
    },
    { name: `gatsby-plugin-sharp` }
  )

  // We're now processing the file's jobs.
  let imagesFinished = 0

  bar.total = totalJobs

  try {
    const promises = processFile(
      job.inputPath,
      job.contentDigest,
      jobs.map(job => job.job),
      pluginOptions
    ).map(promise =>
      promise
        .then(job => {
          findDeferred(job).resolve()
        })
        .catch(err => {
          findDeferred(job).reject({
            err,
            message: `Failed to process image ${job.inputPath}`,
          })
        })
        .then(() => {
          imagesFinished += 1

          // only show progress on build
          if (reportStatus) {
            bar.tick()
          }

          boundActionCreators.setJob(
            {
              id: jobId,
              imagesFinished,
            },
            { name: `gatsby-plugin-sharp` }
          )
        })
    )

    Promise.all(promises).then(() => {
      boundActionCreators.endJob({ id: jobId }, { name: `gatsby-plugin-sharp` })
      cb()
    })
  } catch (err) {
    jobs.forEach(({ deferred }) => {
      deferred.reject({
        err,
        message: err.message,
      })
    })
  }
}

export { scheduleJob, setJobToProcess }
