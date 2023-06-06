import fetchWithTimeout from "../fetchWithTimeout";
import 'isomorphic-fetch';
import poll from "../poll";
import { captureException, captureMessage } from '@sentry/nextjs'

const paymentUtil = async (appointmentObject, paymentObject, paymentType, orderId = '', cookiePayload, setCookie, basicPayload, ctxNotes) => {

    const logProcess = async (stage, payload, statusCode, orderId) => {

        try {
            let logProcess = await fetch(`/api/client/process-logger`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api: 'paymentUtil',
                    stage: stage,
                    payload: payload,
                    statusCode: statusCode,
                    keyId: orderId
                })
            });

        } catch (error) {

        }

        return;
    }

    /**
     * 
     * @param {*} resolve 
     * @param {*} reject 
     * @returns 
     */
    const paymentProcess = async (resolve, reject) => {

        let responsePayload = {
            process: [],
            error: [],
        };

        let errorArray = [];
        let processArray = [];

        try {

            let thisPaymentAttempt = {};

            responsePayload.orderId = orderId;
            responsePayload.paymentObject = paymentObject;

            const initiatePaymentController = new AbortController();
            const initiatePaymentTimeoutId = setTimeout(() => {
                initiatePaymentController.abort();
            }, 7000);

            /**
             * * Initiating an order in razorpay and creating a payment doc
             */
            let rzpCreateOrder = await fetch(`/api/client/clinic/initiate-payment-razorpay`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount: paymentObject?.amountToPay ? paymentObject.amountToPay : '',
                    orderId: orderId,
                    ctxNotes: ctxNotes,
                    paymentType: paymentType,
                    basicPayload: basicPayload,
                }),
                signal: initiatePaymentController.signal,
            });

            if (!rzpCreateOrder.ok) {
                errorArray.push('rzpCreateOrder');
                processArray.push('!rzpCreateOrder.ok');

                responsePayload.error = errorArray;
                responsePayload.process = responseArray;

                clearTimeout(initiatePaymentTimeoutId);
                resolve({ status: 500, m: 'Oops! Something went wrong. Please try in sometime.', payload: { responsePayload } });
            }

            let rzpCreateOrderResult = await rzpCreateOrder.json();

            clearTimeout(initiatePaymentTimeoutId);

            if (rzpCreateOrderResult.status == 304 || rzpCreateOrderResult.status == 500) {

                responsePayload.rzpCreateOrderResultStatus = rzpCreateOrderResult?.status;

                errorArray.push('rzpCreateOrderResult');
                processArray.push('rzpCreateOrderResult304|500');

                responsePayload.error = errorArray;
                responsePayload.process = processArray;

                resolve({ status: 304, m: 'Oops! Something went wrong. Please try in sometime.', payload: { responsePayload } });
            }

            processArray.push('rzpCreateOrderResultSuccess');

            cookiePayload.paymentStatus = 'rzpOrderCreated'; // this order created is razorpay order
            setCookie('clnyBooking', JSON.stringify(cookiePayload), { sameSite: 'strict', maxAge: 86400 });

            // * response from initiate-payment-razorpay
            let { amount, id: order_id, currency, _paymentId, paymentId } = rzpCreateOrderResult.payload;

            responsePayload.paymentId = paymentId;

            thisPaymentAttempt = { order_id: order_id, _paymentId: _paymentId, paymentId: paymentId, orderId: orderId };

            let logPayload = {
                orderId: orderId ? orderId : '',
                paymentId: paymentId ? paymentId : '',
                order_id: order_id ? order_id : '',
            }

            const options = {
                key: process.env.NEXT_PUBLIC_RAZORPAY_ID,
                amount: amount,
                currency: currency,
                name: basicPayload?.clinicName ? basicPayload.clinicName : '',
                description: basicPayload?.description ? basicPayload.description : '',
                order_id: order_id,
                handler: async function (response) {

                    try {
                        captureMessage(`rzpHandler -> orderId: ${orderId}`);
                        processArray.push('insideHandler');

                        cookiePayload.status = 'paySuccess';
                        cookiePayload.paymentStatus = 'paySuccess';
                        cookiePayload.rzpOpen = false;
                        setCookie('clnyBooking', JSON.stringify(cookiePayload), { sameSite: 'strict', maxAge: 86400 });
                        
                        processArray.push('beforePSR');

                        // * Verfiying the authenticity of this payment by sending the signature received after successful payment
                        let saveResponseResult = {};
                        try {
                            captureMessage(`rzpHandler -> beforePSR: ${orderId}`);
                            saveResponseResult = await fetchWithTimeout(`/api/client/payment-success-razorpay`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    order_id: order_id, // razorpay order id
                                    orderId: orderId, // our orderId
                                    _paymentId: _paymentId,
                                    paymentId: paymentId,
                                    razorpay_payment_id: response.razorpay_payment_id,
                                    razorpay_order_id: response.razorpay_order_id,
                                    razorpay_signature: response.razorpay_signature,
                                })
                            }, 8000, 5, 700);
                        } catch (error) {

                            captureException(error);
                            await logProcess('psrError', logPayload, 203, orderId);

                            const errorObject = { name: error?.name, message: error?.message, stack: error?.stack };
                            errorArray.push('saveResponseResult');
                            processArray.push('errorPSR');
                            responsePayload.saveResponseResultError = errorObject;

                            saveResponseResult.status = 203;
                        }

                        // * if payment is verified
                        if (saveResponseResult.status == 200) {

                            responsePayload.process = processArray;
                            responsePayload.error = errorArray;

                            resolve({ status: 200, payload: { saveResponseResult, paymentObject: { status: 'paid', amount, currency, order_id, _paymentId, paymentId, pgName: 'razorpay', }, responsePayload } });

                        } else if (saveResponseResult.status == 201) {

                            // * Signature didn't match. Unauthorized
                            captureMessage(`rzpHandler: 201 -> orderId: ${orderId}`);
                            await logProcess('saveResponseResult', logPayload, 201, orderId);

                            processArray.push('signatureMismatch');

                            cookiePayload.status = 'payVerifyFail';
                            cookiePayload.paymentStatus = 'payVerifyFail';
                            cookiePayload.state = 'failed';
                            setCookie('clnyBooking', JSON.stringify(cookiePayload), { sameSite: 'strict', maxAge: 86400 });

                            responsePayload.saveResponseResultStatus = 201;
                            responsePayload.error = errorArray;
                            responsePayload.process = processArray;

                            resolve({ status: 201, m: 'Verification Failed', payload: { responsePayload } });

                        } else if (saveResponseResult.status == 203) {

                            captureMessage(`rzpHandler: 203 -> orderId: ${orderId}`);
                            await logProcess('saveResponseResult', logPayload, 203, orderId);

                            processArray.push('poll-payment-status');

                            // Poll function
                            const checkPaymentStatus = async () => {
                                return await fetch(`/api/client/poll-payment-status`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        razorpay_payment_id: response.razorpay_payment_id,
                                        razorpay_order_id: response.razorpay_order_id,
                                        razorpay_signature: response.razorpay_signature,
                                        _paymentId: _paymentId,
                                    })
                                });
                            };

                            // Poll validation function
                            let checkPaymentValidate = (result) => result.status == 200;

                            const pollForPaymentStatus = poll({ fn: checkPaymentStatus, validate: checkPaymentValidate, interval: 700, maxAttempts: 6 }).then(result => {
                                processArray.push('pollPaymentStatusSuccess');

                                if (!(result && Object.keys(result).length === 0 && result.constructor === Object) && 'transferSignature' in result) {
                                    processArray.push('addingTransferSignature');

                                    saveResponseResult.transferSignature = result.transferSignature;
                                }

                                responsePayload.process = processArray;
                                responsePayload.error = errorArray;

                                // * payment confirmed and verified
                                resolve({ status: 200, payload: { saveResponseResult, paymentObject: { status: 'paid', amount, currency, order_id, _paymentId, paymentId, pgName: 'razorpay', }, responsePayload: responsePayload } });

                            }).catch(error => {

                                // can't do anything. Still save the appointment preference details
                                captureException(error);
                                logProcess('pollForPaymentStatusError', logPayload, 408, orderId);

                                processArray.push('pollPaymentStatusError');
                                errorArray.push('pollPaymentStatus');
                                const errorObject = { name: error?.name, message: error?.message, stack: error?.stack };
                                responsePayload.pollPaymentStatusError = errorObject;

                                responsePayload.process = processArray;
                                responsePayload.error = errorArray;

                                cookiePayload.status = 'payVerifyFail';
                                cookiePayload.paymentStatus = 'payVerifyFail';
                                cookiePayload.state = 'failed';
                                setCookie('clnyBooking', JSON.stringify(cookiePayload), { sameSite: 'strict', maxAge: 86400 });

                                resolve({ status: 408, m: 'payVerifyFail', payload: { responsePayload } });
                            });
                        } else {

                            captureMessage(`rzpHandler: 409 -> orderId: ${orderId}`);
                            await logProcess('saveResponseResult', logPayload, 409, orderId);

                            processArray.push('saveResponseResultElseFail');

                            responsePayload.process = processArray;
                            responsePayload.error = errorArray;

                            cookiePayload.status = 'payVerifyFail';
                            cookiePayload.paymentStatus = 'payVerifyFail';
                            cookiePayload.state = 'failed';
                            setCookie('clnyBooking', JSON.stringify(cookiePayload), { sameSite: 'strict', maxAge: 86400 });

                            resolve({ status: 409, m: 'payVerifyFail', payload: { responsePayload } });
                        }
                    } catch (error) {

                        captureException(error);

                        await logProcess('handlerMasterError', logPayload, 500, orderId);
                        processArray.push('handlerMasterError');
                        errorArray.push('handlerMasterError');

                        const errorObject = { name: error?.name, message: error?.message, stack: error?.stack };
                        responsePayload.handlerError = errorObject;
                        
                        responsePayload.process = processArray;
                        responsePayload.error = errorArray;

                        cookiePayload.status = 'payVerifyFail';
                        cookiePayload.paymentStatus = 'payVerifyFail';
                        cookiePayload.state = 'failed';
                        setCookie('clnyBooking', JSON.stringify(cookiePayload), { sameSite: 'strict', maxAge: 86400 });

                        resolve({ status: 408, m: 'Oops! Something went wrong.', payload: { responsePayload } });
                        
                    }

                },
                theme: { 'color': '#09382E' },
                modal: {
                    'onDismiss': function () {
                        processArray.push('onDismiss');
                        responsePayload.process = processArray;
                        responsePayload.error = errorArray;
                        
                        resolve({ status: 204, m: 'Closed', payload: { responsePayload } });
                    }
                }
            }

            processArray.push('settingOptions');
            const rzpPaymentObject = new window.Razorpay(options);

            rzpPaymentObject.on('payment.failed', async function (response) {

                captureMessage(`payment.failed -> orderId: ${orderId} -> ${JSON.stringify(response)}`);
                await logProcess('payment.failed', logPayload, 401, orderId);
                processArray.push('payment.failed');
 
                responsePayload.paymentFailResponse = JSON.stringify(response);
                
                // * not resolving here in order to avoid the retry payment error. Now user will have to dismiss or retry on their own
                alert(response?.error?.description);
            });

            cookiePayload.rzpOpen = true;
            setCookie('clnyBooking', JSON.stringify(cookiePayload), {sameSite: 'strict', maxAge: 86400});

            processArray.push('openingModal');

            // * Opening the modal
            rzpPaymentObject.open();


        } catch (error) {

            captureException(error);
            await logProcess('paymentUtilMasterError', { orderId: orderId, }, 500, orderId);

            processArray.push('paymentUtilMasterError');
            errorArray.push('paymentUtilMaster');

            responsePayload.process = processArray;
            responsePayload.error = errorArray;

            const errorObject = { name: error?.name, message: error?.message, stack: error?.stack };
            responsePayload.paymentUtilError = errorObject

            // * If any request is aborted from above code, it is thrown as error and will be caught here
            resolve({ status: 500, m: 'Oops! Something went wrong.', payload: { responsePayload } });
        }
    };

    return new Promise(paymentProcess);

};

export default paymentUtil;
