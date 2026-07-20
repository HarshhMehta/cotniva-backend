const { secret } = require("../config/secret");
const cloudinary = require("../utils/cloudinary");
const { Readable } = require('stream');


const cloudinaryImageUpload = (imageBuffer) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        upload_preset: secret.cloudinary_upload_preset,
        transformation: null,
        crop: "limit",
        width: 1920,
        height: 1000,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );

    const bufferStream = new Readable();
    bufferStream.push(imageBuffer);
    bufferStream.push(null);

    bufferStream.pipe(uploadStream);
  });
};

/** Upload image or video for gallery.
 * Videos cannot use the image upload_preset (it applies g_auto which Cloudinary rejects on video).
 */
const cloudinaryMediaUpload = (fileBuffer, resourceType = "auto") => {
  return new Promise((resolve, reject) => {
    const options =
      resourceType === "video"
        ? {
            resource_type: "video",
            folder: "shofy-gallery",
          }
        : {
            upload_preset: secret.cloudinary_upload_preset,
            resource_type: "image",
            folder: "shofy-gallery",
          };

    const uploadStream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );

    const bufferStream = new Readable();
    bufferStream.push(fileBuffer);
    bufferStream.push(null);
    bufferStream.pipe(uploadStream);
  });
};


// cloudinaryImageDelete
// const cloudinaryImageDelete = async (public_id) => {
//   const deletionResult = await cloudinary.uploader.destroy(public_id);
//   return deletionResult;
// };
const cloudinaryImageDelete = async (public_id) => {
  try {
    console.log(`Attempting to delete image from Cloudinary: ${public_id}`);
    const deletionResult = await cloudinary.uploader.destroy(public_id);
    
    if (deletionResult.result === 'ok') {
      console.log(`Successfully deleted image: ${public_id}`);
    } else if (deletionResult.result === 'not found') {
      console.warn(`Image not found in Cloudinary: ${public_id}`);
    } else {
      console.warn(`Unexpected deletion result for ${public_id}:`, deletionResult);
    }
    
    return deletionResult;
  } catch (error) {
    console.error(`Error deleting image from Cloudinary (${public_id}):`, error);
    throw error;
  }
};

exports.cloudinaryServices = {
  cloudinaryImageDelete,
  cloudinaryImageUpload,
  cloudinaryMediaUpload,
};
